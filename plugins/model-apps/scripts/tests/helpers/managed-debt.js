'use strict';
// Seeds a managed binding store (lib/managed-bindings.js) with the debt an earlier run of the build can leave behind, through
// the store's own operations, so a test of a later entry (a build, a page edit, a teardown) meets exactly what discovery would:
//   pending    an attempt marked sending whose change is not proved (its table is held); cknowledged also records that the
//              create's answer came back (an acknowledged attempt that was never committed);
//   uncertain  a committed group whose table publish was dispatched and never confirmed (its table is blocked).
// The expectation is a placeholder hash no real row matches, so a proof of it always fails.

const crypto = require('node:crypto');
const { openManagedBindings } = require('../../lib/managed-bindings.js');

const PLACEHOLDER = 'a'.repeat(64);

/**
 * @param {{ workspaceDir: string, environment: string, appUniqueName: string, solutionUniqueName: string }} args
 * @param {{ family?: string, key?: string, id?: string, table?: string, acknowledged?: boolean, uncertain?: boolean }} [debt]
 * @returns {{ store: object, token: string }}
 */
function seedManagedDebt(args, { family = 'view', key = 'account/held', id = '11111111-2222-4333-8444-555555555555', table = 'account', acknowledged = false, uncertain = false } = {}) {
  const store = openManagedBindings(args);
  const token = store.prepareAttempt({
    family, key, root: { kind: family, key, id }, baseGeneration: null,
    expected: { proofVersion: 1, proofSchema: `${family}-v1`, rootId: id, baseProofSha256: null, sentProjectionSha256: PLACEHOLDER, preservationSha256: PLACEHOLDER, baseObservation: null, children: [] },
    knownScopes: [{ type: 'table', table }], declarationSha256: 'b'.repeat(64),
  });
  if (acknowledged || uncertain) store.noteSaved(token, { acknowledgedRoot: true });
  if (uncertain) {
    const env = store.snapshot().envelope;
    store.commitGroup({
      token, baseGeneration: null, proofSchema: `${family}-v1`,
      records: [{ formatVersion: 1, appUniqueName: env.appUniqueName, environmentFingerprint: env.environmentFingerprint, kind: family, key, id, origin: 'created', intentSha256: PLACEHOLDER }],
      proof: { savedSha256: PLACEHOLDER, semanticSha256: PLACEHOLDER, preservationSha256: PLACEHOLDER, expectedChildrenSha256: null },
      consumerState: { baseline: { intentSha256: PLACEHOLDER } },
      publication: { scope: { type: 'table', table }, state: 'owed', desiredSha256: PLACEHOLDER, dispatchToken: null },
    });
    const dispatch = crypto.randomUUID();
    store.markPublishDispatch({ groups: [{ family, key }], scope: { type: 'table', table }, token: dispatch });
    store.notePublishOutcome({ token: dispatch, outcome: 'unconfirmed' });
  }
  return { store, token };
}

module.exports = { seedManagedDebt };

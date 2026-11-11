'use strict';
// The JSON body the vendored SDK's push sends to create one artifact, worked out without sending it. Shared by the stable
// view/chart creates (creates-stable-build.js) and the declared dashboard create receipt (dashboard-reconcile.js): each pins
// its one create POST to the body this answers, so the request the push actually dispatches must carry the draft this build
// made, field for field.

const { normalizeGuid } = require('./reconcile-common.js');

/**
 * The JSON body the SDK's push sends to create `artifact` at `id`: the same SDK, made over a throwaway workspace
 * (lib/throwaway-sdk.js) with the same connection, language and solution, is given the draft and pushed, and its first write
 * is captured and never sent (nor any write after it). Its reads go to the real connection (a view's push reads its table's
 * metadata for the layout, one GET; a chart's and a dashboard's read nothing), so the body is serialised exactly as the real
 * push serialises it — from the draft held in memory, not from any file a second process could change. Throws when that
 * cannot be shown: no SDK connection, or a first write that is not one POST to `family.collection` naming `id`.
 *   POST https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries?$select=savedqueryid
 *   { "name": "Declared Items", "fetchxml": "<fetch …>", "layoutxml": "<grid …>", …, "savedqueryid": "a1d1e2a3-…" }
 *
 * How the draft is loaded into the throwaway workspace (`family.load`):
 *   'create'  `createArtifact(kind, artifact)` — a view or chart draft as createArtifact answered it. The SDK fills a fresh
 *             default and lays the draft over it, which for these kinds is the draft itself.
 *   'write'   the SDK's own `workspace.writeArtifact(kind, id, artifact)` — a dashboard. Its `createArtifact` would REPLACE the
 *             bag with a fresh default layout, losing the reseeded tab and section and every caption edit the build already
 *             made, so the complete assembled draft is written as it is, with no saved snapshot: the push then reads it as a
 *             new artifact and serialises its create normally. Nothing of it is rewritten here.
 *
 * @param {object} sdk  the build's SDK (its `dataverse` connection and `languageCode` are reused)
 * @param {{ kind: string, collection: string, idField: string, load?: 'create'|'write' }} family
 * @param {string} id
 * @param {object} artifact
 */
async function expectedCreateBody(sdk, family, id, artifact) {
  const { kind, collection, idField, load = 'create' } = family || {};
  const conn = sdk && sdk.dataverse;
  if (!conn || typeof conn.instanceUrl !== 'string' || !conn.httpClient || typeof conn.httpClient.get !== 'function') {
    throw new Error('the SDK exposes no connection to serialise the create with');
  }
  const { withThrowawaySdk } = require('./throwaway-sdk.js');
  const DRY = Symbol('dry');
  let captured = null;
  const client = { get: (url, options) => conn.httpClient.get(url, options) };
  for (const m of ['post', 'patch', 'put', 'delete']) {
    client[m] = async (url, body) => {
      if (!captured) captured = { method: m, url: String(url), body };
      throw Object.assign(new Error('not sent: the create body is only being worked out'), { [DRY]: true });
    };
  }
  await withThrowawaySdk({ env: conn.instanceUrl, prefix: 'create-body-', httpClient: client }, async (make) => {
    const dry = make({
      ...(typeof sdk.languageCode === 'number' || typeof sdk.languageCode === 'string' ? { languageCode: sdk.languageCode } : {}),
      ...(typeof conn.solutionUniqueName === 'string' && conn.solutionUniqueName ? { solutionUniqueName: conn.solutionUniqueName } : {}),
    });
    await dry.initWorkspace();
    if (load === 'write') {
      if (!dry.workspace || typeof dry.workspace.writeArtifact !== 'function') throw new Error('the SDK exposes no workspace to load the draft into');
      await dry.workspace.writeArtifact(kind, id, JSON.parse(JSON.stringify(artifact)));
    } else {
      await dry.createArtifact(kind, artifact);
    }
    try {
      await dry.pushArtifact(kind, id);
    } catch (err) {
      if (!captured) throw err;
    }
  });
  if (!captured) throw new Error('the push sent no create');
  let path = '';
  try { path = new URL(captured.url, conn.instanceUrl).pathname; } catch { /* checked below */ }
  let body = captured.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (captured.method !== 'post' || !path.toLowerCase().endsWith(`/${String(collection).toLowerCase()}`) || !body || typeof body !== 'object' || Array.isArray(body)
    || normalizeGuid(body[idField]) !== normalizeGuid(id)) {
    throw new Error(`the push's first write was not one create of ${id}`);
  }
  return body;
}

module.exports = { expectedCreateBody };

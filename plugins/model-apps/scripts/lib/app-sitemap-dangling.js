'use strict';
// The teardown of a published app whose SiteMap component names a sitemap that no longer exists: proving that sitemap gone, then deleting the app alone.
//
// WHY. An app is two rows, the appmodule and its sitemap, and the bundled SDK deletes them together (one change set) once it has resolved the sitemap
// from the app's current layer: an app deleted on its own while its sitemap exists strands that row and keeps its unique name taken for good
// (AGENTS.md, "An app is TWO rows"). When the sitemap row is gone, that resolution cannot finish and the SDK refuses. Refusing is right while it
// cannot tell, but the row can be gone for good: before 2.18.0, the teardown of one app deleted a sitemap that another app shared, and — measured
// live — the other app's SiteMap component outlives the row it names. 2.17.0's delete looked an app's sitemap up by the app's unique name and, when
// no sitemap had that name, deleted such an app alone; the component-aware delete of the 2.18.0 SDK refuses it on every run, and its "Retry." can never get past that.
//
// SCOPE. This is the app step of a teardown. A teardown that stops before it never gets here: an app with live generative pages has them proven from
// its navigation first (sdk-teardown.js, the pages' resolve), and with that navigation gone the proof stops the teardown, as it always did — the maker
// deletes such an app in Power Apps, then runs the teardown again. So is an app that was never published refused here (step 0 below).
//
// THE SDK'S REFUSAL, the one this module acts on (the vendored bundle's app delete: deleteAppCascade, and the sitemap resolution it starts with):
//   SdkError {
//     code: "APP_SITEMAP_UNRESOLVED",
//     message: "Refusing to delete app '9e9aabc1-e978-4322-a0ad-f1c16d5b90ab': sitemap 'a8252d00-b5c5-4026-bfbf-090a7001cff5' was not returned by the
//               unpublished-aware read. Deleting the app would destroy the only pointer to its sitemap, stranding that row and reserving its unique
//               name forever. Retry."
//   }
// The SDK raises it when it found ONE SiteMap component on the app's current layer, and its read of that sitemap in the saved layer
//   GET /sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid,sitemapnameunique,sitemapxml&$filter=sitemapid eq <id>&$top=1
// answered no row — or an answer with no list in it, which it does not tell apart. It raises the same code for every other way that resolution fails (a
// layer or a component it cannot read, two components, a link that changes while it reads, a renamed or malformed row), and nothing in the error
// says which, so the SENTENCE is matched: anchored on the SDK's own fixed words, both ids GUIDs, and the app the one being deleted. Every other
// refusal stays exactly as the SDK words it. The match only CHOOSES this path; nothing is deleted on the SDK's word. What decides is the proof below,
// made with reads of this module's own. An SDK that words the refusal otherwise leaves teardown refusing as before
// (tests/teardown-dangling-sitemap-real-bundle.test.js has the real bundle raise it, word for word).
//
// THE PROOF. Every read is strict: an answer that is refused, is no list, or pages wrongly is "not proven", never "absent" (app-components.js
// collectionRows).
//   0. FIRST, the app's row version, from its read by id. Everything after it is proven of the app AT this version, and the delete is conditioned on
//      it: a repair, a relink or a publish of the app while the proof runs moves the version, and the platform then refuses the delete (412), which is
//      a final refusal here. A version read after the proof would carry such a change in with it — the delete would then act on an app nothing proved.
//      (The 2.17.0 SDK's own app delete reads the app's version first, for the same reason.)
//   1. the link: the app's current layer, and exactly one SiteMap component on it, naming the sitemap the SDK named;
//   2. that sitemap, by its id, in the PUBLISHED layer (a plain read of the collection) and in the SAVED layer (RetrieveUnpublishedMultiple): no row
//      in either;
//   3. no OTHER app's current layer names it — the rule the SDK applies before it deletes a sitemap that two apps use (APP_SITEMAP_SHARED);
//   4. the link again, unchanged: a relink while this module reads is caught, as the SDK's own second read of the link catches one.
// Then ONE write: DELETE /appmodules(<id>) with If-Match on the version of step 0 — the app alone. No sitemap is written or deleted. Then the app is
// read in both layers again: it is gone, or the step fails. Anything else refuses and says what was found and what the maker can do; a refusal is final
// (retry-policy.js `refusal`: `transient: false`) and does not ask for a retry, which could not change what was found.
// What the version cannot see: a change of OTHER rows after the last read — another app adding a pin to the sitemap, a sitemap of that id made
// again — moves no version of this app. That is the snapshot the SDK's own reverse-owner check is ("not a cross-app lock").
//
// FAIL CLOSED. Every error that leaves this path is marked `failClosed` (sdk-teardown.js passes such an error on before any of deleteStep's
// shortcuts): its words can be the maker's — the app's display name — or the platform's ("Resource not found …"), and read as words they could pass
// for a row that is already gone or an artifact that cannot be deleted, and let the steps that depend on a live app run.
// See https://learn.microsoft.com/power-apps/developer/data-platform/webapi/reference/retrieveunpublishedmultiple
// and https://learn.microsoft.com/power-apps/developer/data-platform/webapi/perform-conditional-operations-using-web-api#apply-optimistic-concurrency
const { collectionRows, currentAppLayer, appComponentRows } = require('./app-components.js');
const { FORM_GUID_RE } = require('./app-spec.js');
const { refusal, serviceFailure } = require('./retry-policy.js');

// componenttype 62 is a site map: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodulecomponent
const SITEMAP_COMPONENT = 62;
const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SITEMAP_GONE_REFUSAL = new RegExp(`^Refusing to delete app '(${GUID})': sitemap '(${GUID})' was not returned by the unpublished-aware read\\. `);
const guidKey = (id) => String(id || '').replace(/^\{|\}$/g, '').toLowerCase();
const reasonOf = (error) => String((error && error.message) || error || 'read failed');

// The sitemap the SDK could not find when it refused to delete the app `appId` ({ sitemapId }), or null for any other failure — see the header.
function danglingSitemapOf(error, appId) {
  if (!error || error.code !== 'APP_SITEMAP_UNRESOLVED' || typeof error.message !== 'string') return null;
  const named = SITEMAP_GONE_REFUSAL.exec(error.message);
  if (!named || guidKey(named[1]) !== guidKey(appId)) return null;
  return { sitemapId: guidKey(named[2]) };
}

// Steps 1 and 4: the app's current layer, and the one sitemap its SiteMap component names there — { ok: true, layer, sitemapId } | { ok: false, why }. The
// layer is the one the SDK resolves (componentstate 1 when a pending edit makes the platform answer with both layers: app-components.js currentLayerRows).
//   GET /appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq <layer> and componenttype eq 62
//   { "value": [ { "objectid": "a8252d00-b5c5-4026-bfbf-090a7001cff5", "componenttype": 62 } ] }
async function readLink(client, appId) {
  const current = await currentAppLayer(client, appId);
  if (!current.ok) return { ok: false, why: `the app's current layer could not be read (${current.reason})` };
  let rows;
  try {
    rows = await appComponentRows(client, current.appModuleIdUnique, SITEMAP_COMPONENT, { strict: true });
  } catch (error) {
    return { ok: false, why: `the app's SiteMap component could not be read (${reasonOf(error)})` };
  }
  if (rows.length !== 1) return { ok: false, why: `the app's current layer holds ${rows.length} SiteMap components, where an app holds one` };
  return { ok: true, layer: current.appModuleIdUnique, sitemapId: guidKey(rows[0].objectid) };
}

// Step 2: the sitemap by its id in one layer — { state: 'absent' }, or { state: 'present' | 'unread', why }. A plain read of the collection answers the
// PUBLISHED layer only; RetrieveUnpublishedMultiple answers the SAVED one, a never-published row included (a deleted row is in neither):
//   GET /sitemaps?$select=sitemapid&$filter=sitemapid eq <id>                                                      { "value": [] }
//   GET /sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid&$filter=sitemapid eq <id>  { "value": [] }
// A row that is some other sitemap proves nothing either way.
const LAYER_READS = {
  published: (id) => `/sitemaps?$select=sitemapid&$filter=sitemapid eq ${id}`,
  saved: (id) => `/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=sitemapid&$filter=sitemapid eq ${id}`,
};
async function sitemapIn(client, layer, sitemapId) {
  let rows;
  try {
    rows = await collectionRows(client, LAYER_READS[layer](sitemapId), `sitemap '${sitemapId}' in the ${layer} layer`);
  } catch (error) {
    return { state: 'unread', why: `the ${layer} layer could not be read (${reasonOf(error)})` };
  }
  if (!rows.length) return { state: 'absent' };
  if (rows.every((row) => row && guidKey(row.sitemapid) === sitemapId)) return { state: 'present', why: `the ${layer} layer still holds it` };
  return { state: 'unread', why: `the ${layer} layer answered a row that is not that sitemap` };
}

// Step 3: the apps other than `appId` whose CURRENT layer names the sitemap, found as the SDK finds them before it deletes a sitemap: a component names an
// app LAYER, the layer names its app, and the pin counts only while that layer is the app's current one — an old layer of a re-published app does not.
// `ownLayer` (the app's own current layer) is skipped without a read. Throws when any of it cannot be read.
//   GET /appmodulecomponents?$select=_appmoduleidunique_value&$filter=componenttype eq 62 and objectid eq <sitemap>        { "value": [ { "_appmoduleidunique_value": "<layer>" } ] }
//   GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid&$filter=appmoduleidunique eq <layer>  { "value": [ { "appmoduleid": "<app>" } ] }
async function otherAppsNaming(client, sitemapId, appId, ownLayer) {
  const rows = await collectionRows(client,
    `/appmodulecomponents?$select=_appmoduleidunique_value&$filter=componenttype eq ${SITEMAP_COMPONENT} and objectid eq ${sitemapId}`,
    `the apps whose navigation names sitemap '${sitemapId}'`);
  const layers = new Set();
  for (const row of rows) {
    const layer = guidKey(row && row._appmoduleidunique_value);
    if (!FORM_GUID_RE.test(layer)) throw new Error(`a SiteMap component naming sitemap '${sitemapId}' carries no app layer id`);
    if (layer !== ownLayer) layers.add(layer);
  }
  const others = [];
  for (const layer of layers) {
    const apps = await collectionRows(client,
      `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid&$filter=appmoduleidunique eq ${layer}`,
      `the app of layer '${layer}'`);
    for (const app of apps) {
      const id = guidKey(app && app.appmoduleid);
      if (!FORM_GUID_RE.test(id)) throw new Error(`app layer '${layer}' answered a row with no app id`);
      if (id === appId || others.includes(id)) continue;
      const current = await currentAppLayer(client, id);
      if (!current.ok) throw new Error(`the current layer of app '${id}' could not be read (${current.reason})`);
      if (current.appModuleIdUnique === layer) others.push(id);
    }
  }
  return others;
}

// Step 0: the app's row version, which its delete is conditioned on — read FIRST, before anything is proven about the app (see the header), as the SDK
// reads it first for its own delete of an app that has no sitemap. An app's read by id is its PUBLISHED projection, so an app that was never published
// answers 404 (measured; the download tells the maker to publish a new app first):
//   GET /appmodules(<id>)?$select=appmoduleid  ->  200, ETag: W/"1234567"  (the same version is the body's "@odata.etag")
async function appRowVersion(client, appId) {
  let answer;
  try {
    answer = await client.get(`/appmodules(${appId})?$select=appmoduleid`);
  } catch (error) {
    return { ok: false, why: `reading the app failed (${reasonOf(error)})` };
  }
  if (answer && answer.status === 404) return { ok: false, why: 'its read by id answered HTTP 404: it was never published, or it was deleted meanwhile' };
  if (!answer || answer.status < 200 || answer.status >= 300) return { ok: false, why: `reading the app answered HTTP ${answer && answer.status}` };
  const header = Object.entries(answer.headers || {}).find(([name]) => name.toLowerCase() === 'etag');
  const version = header ? header[1] : answer.body && answer.body['@odata.etag'];
  if (typeof version !== 'string' || !version) return { ok: false, why: 'reading the app answered no row version' };
  return { ok: true, version };
}

// Whether the app is gone from both layers, read by its id — { ok: true, gone } | { ok: false, why }. A row of any id counts as "not gone".
//   GET /appmodules?$select=appmoduleid&$filter=appmoduleid eq <id>                                                      { "value": [] }
//   GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid&$filter=appmoduleid eq <id>  { "value": [] }
async function appGone(client, appId) {
  try {
    const published = await collectionRows(client, `/appmodules?$select=appmoduleid&$filter=appmoduleid eq ${appId}`, `app '${appId}' in the published layer`);
    const saved = await collectionRows(client, `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid&$filter=appmoduleid eq ${appId}`, `app '${appId}' in the saved layer`);
    return { ok: true, gone: published.length === 0 && saved.length === 0 };
  } catch (error) {
    return { ok: false, why: reasonOf(error) };
  }
}

// What the DELETE was answered, for a message: the status and the platform's own OData error, or why no answer came.
//   { "error": { "code": "0x80060882", "message": "The version of the existing record doesn't match the RowVersion property provided." } }
function answerOf(answer, failure) {
  if (failure) return `no answer: ${reasonOf(failure)}`;
  const error = answer && answer.body && answer.body.error;
  const words = error && typeof error.message === 'string' ? `: ${error.code ? `${error.code} ` : ''}${error.message}` : '';
  return `HTTP ${answer && answer.status}${words}`;
}

// Deletes the app `appId` (named `appName`) on its own, once the sitemap the SDK could not find (`sitemapId`, from danglingSitemapOf) is proven gone — see the
// header. `client` is the SDK's Dataverse client (`sdk.dataverse`), `refused` the SDK's refusal, kept as the cause of a refusal here. Resolves to { warning }
// (what to tell the maker) once the app is deleted and read back gone from both layers; throws otherwise — every error it throws marked `failClosed`.
// Nothing is written before the proof is complete.
async function deleteAppWithoutSitemap(client, { appId, appName, sitemapId, refused }) {
  const id = guidKey(appId);
  const lead = `app "${appName}" (${id}) was not deleted: its navigation link names sitemap ${sitemapId}, which the SDK could not read.`;
  const ask = 'If this app is yours, delete it in Power Apps (make.powerapps.com, Apps), then run the teardown again: it removes the rest.';
  const unproven = (why) => refusal(`${lead} Teardown deletes such an app on its own only once that sitemap is proven gone, and it could not prove it: ${why}. Nothing was deleted. ${ask}`, { cause: refused, failClosed: true });
  if (!client || typeof client.get !== 'function' || typeof client.delete !== 'function') throw unproven('there is no Dataverse client to read it with');

  // Step 0, before anything is proven: the version the delete is conditioned on. Never read again after the proof — see the header.
  const row = await appRowVersion(client, id);
  if (!row.ok) throw refusal(`${lead} Teardown deletes such an app on its own only with a delete conditioned on the app's row version, and it could not read one: ${row.why}. Nothing was deleted. ${ask}`, { cause: refused, failClosed: true });
  const link = await readLink(client, id);
  if (!link.ok) throw unproven(link.why);
  if (link.sitemapId !== sitemapId) throw unproven(`the app's SiteMap component names sitemap ${link.sitemapId} now`);
  for (const layer of ['published', 'saved']) {
    const found = await sitemapIn(client, layer, sitemapId);
    if (found.state !== 'absent') throw unproven(found.why);
  }
  let others;
  try {
    others = await otherAppsNaming(client, sitemapId, id, link.layer);
  } catch (error) {
    throw unproven(`which apps name it could not be read (${reasonOf(error)})`);
  }
  if (others.length) throw unproven(`the navigation of app ${others.map((other) => `'${other}'`).join(', ')} names it too`);
  const again = await readLink(client, id);
  if (!again.ok) throw unproven(again.why);
  if (again.layer !== link.layer || again.sitemapId !== sitemapId) throw unproven(`the link changed while teardown read it (sitemap ${sitemapId}, then sitemap ${again.sitemapId})`);

  // The one write, conditioned on the version of step 0. A delete that gets no answer is not sent again (lib/sdk-http-client.js never re-sends a
  // conditional write it has no answer to): the reads below say whether it ran.
  let answer;
  let failure = null;
  try {
    answer = await client.delete(`/appmodules(${id})`, { headers: { 'If-Match': row.version } });
  } catch (error) {
    failure = error;
  }
  const gone = await appGone(client, id);
  if (!gone.ok) {
    throw Object.assign(new Error(`app "${appName}" (${id}): its sitemap ${sitemapId} is gone and the app's delete was sent (${answerOf(answer, failure)}), but whether the app is gone could not be read (${gone.why}), so the steps that depend on it are not attempted. Run the teardown again: it finds the app gone, or proves its sitemap gone again and deletes it.`), { failClosed: true, ...(failure ? { cause: failure } : {}) });
  }
  if (!gone.gone) {
    // 412: the app's version is no longer the one the proof began at — the app changed while it ran (a repair, a relink, a publish), and nothing proven
    // holds for the app as it is now. Final, as every refusal of the proof is: the next teardown proves the app as it is then.
    //   { "error": { "code": "0x80060882", "message": "The version of the existing record doesn't match the RowVersion property provided." } }
    if (!failure && answer && answer.status === 412) {
      throw refusal(`app "${appName}" (${id}) was not deleted: its sitemap ${sitemapId} is gone, but the app changed while teardown was proving that, so the platform refused a delete conditioned on the version the proof began at (${answerOf(answer)}). Nothing was deleted. Run the teardown again: it proves the app as it is now before it deletes anything.`, { cause: refused, failClosed: true });
    }
    throw Object.assign(serviceFailure(`app "${appName}" (${id}) was not deleted: its sitemap ${sitemapId} is gone, but the delete of the app on its own did not remove it (${answerOf(answer, failure)}). Nothing else was deleted. Run the teardown again; if the app stays, and it is yours, delete it in Power Apps (make.powerapps.com, Apps), then run the teardown again: it removes the rest.`, {
      status: answer && answer.status,
      answered: answer && answer.body && answer.body.error,
      cause: failure || refused,
    }), { failClosed: true });
  }
  return { warning: `app "${appName}" (${id}) was deleted without its sitemap: its navigation link named sitemap ${sitemapId}, which is in neither the published nor the saved layer (the teardown of another app that shared it can leave an app so), so there was none to delete, and no sitemap was touched` };
}

module.exports = { danglingSitemapOf, deleteAppWithoutSitemap };

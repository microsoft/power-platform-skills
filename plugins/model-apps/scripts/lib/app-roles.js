'use strict';
// What the environment says about who can OPEN a model-driven app: the security roles associated with it — the N:N `appmoduleroles` relationship, the
// rows the app launcher reads to decide which apps a user without a maker-level role sees. READ-ONLY: nothing here writes, and every failure is an
// answer ({ ok: false, reason } / { state: 'unreadable' }), never a throw, because both callers report what they could not read instead of failing on it.
//
//   verify-model-app.js  appIdFor / appRoleIdsFor — the ids of the roles a deployed app has, to prove the app is associated with the roles its personas author.
//                        They read as they always did: the published layer, and an answer that carries no list is read as no ids (verify then FAILS the persona's
//                        check, the safe side).
//   write-app-spec-doc.js  appRolesOf — the roles (by name) an app has, for the design document: an extension of an app that already has roles
//                          says nothing about them in its spec, and the document is where a reviewer is told what they are. It states what it read, so it is
//                          strict where verify is lenient: see below.
//
// What the document reads must be an ANSWER, never a guess.
//   * The app is looked up in the SAVED layer — `resolveArtifact('app', { uniqueName })`, the SDK's own lookup, which the teardown deletes an app by and which finds
//     a draft (lib/sitemap-pages.js neverPublishedNavigation) — and not by the published-layer probe the build and verify make (`findArtifact`, `queryRecords`): an
//     app that was saved and never published has no published row, and "does not exist yet" is a statement about the environment that probe cannot make. An app is
//     absent only when the saved layer, which holds the published apps too, has none.
//   * The roles are read through collectionRows (lib/app-components.js), the plugin's one reader of a paged collection: a refusal, an answer that is no list, a link
//     that is no link and a page that repeats are each an error, never a shorter list, and the continuation is followed to its end. Every row must then name a role.
//     Only a list with nothing in it says the app has no role; a draft whose roles the platform will not read (HTTP 404 by id for an app with no published row), a
//     refused read and a malformed answer are each "unreadable" — which the document words as "not checked".
//
// The relationship is read directly (`GET /appmodules(<id>)/appmoduleroles_association`): the SDK has associate and disassociate helpers for it
// and no modeled read.
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule
//      https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/share-model-driven-app
const { odataLit } = require('./odata.js');
const { compareText } = require('./compare-text.js');
const { collectionRows } = require('./app-components.js');

// A failure as the one line a caller shows: the message, cut at 200 characters (an error text can carry a whole response body).
const reasonOf = (err) => ((err && err.message) ? String(err.message).slice(0, 200) : 'read failed');

// The association rows of an app, with the role columns in `select` (the navigation property answers role rows).
const associationPath = (appId, select) => `/appmodules(${appId})/appmoduleroles_association?$select=${select.join(',')}`;

// Resolve the app module id from its unique name, in the published layer. Undefined when there is no such app there.
async function appIdFor(sdk, appUnique) {
  const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  return rows && rows[0] && rows[0].appmoduleid;
}

// verify's view: the ids of the roles the deployed app has, lower-cased, so verify proves the app<->role rows the launcher uses rather than inferring
// access from a role's existence or from the build's result. { ok: true, roleIds } | { ok: false, reason }. Unchanged from before the design document read the
// same relationship — including what it makes of an answer that carries no list — and kept apart from appRolesOf's strictness on purpose.
async function appRoleIdsFor(sdk, appUnique) {
  try {
    const appId = await appIdFor(sdk, appUnique);
    if (!appId) return { ok: false, reason: `app '${appUnique}' could not be resolved` };
    if (!sdk.dataverse || typeof sdk.dataverse.get !== 'function') return { ok: false, reason: 'SDK dataverse reader is unavailable' };
    const res = await sdk.dataverse.get(associationPath(appId, ['roleid']));
    if (!res || res.status < 200 || res.status >= 300) return { ok: false, reason: `HTTP ${res && res.status}` };
    return {
      ok: true,
      roleIds: ((res.body && res.body.value) || [])
        .map((r) => r && r.roleid)
        .filter(Boolean)
        .map((id) => String(id).toLowerCase()),
    };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

/**
 * The roles associated with the app `appUnique`, as the environment holds them now.
 *   { state: 'read', appUnique, appId, roles: [{ roleId, name, managed }] }   `roles` by name (lib/compare-text.js), then id: the same order on every run
 *   { state: 'absent', appUnique }                                            neither layer has an app of that unique name, so a build creates it
 *   { state: 'unreadable', appUnique, reason }                                the app or its roles could not be read: nothing is known about them
 * `reason` is `HTTP <status>` for a refusal and the error's own words otherwise. A role with no name is listed with the empty one; a row with no role id is not a
 * role, and an answer that holds one is unreadable.
 * @param {object} sdk the bundled SDK (lib/maker-sdk.js)
 * @param {string} appUnique the app's unique name
 */
async function appRolesOf(sdk, appUnique) {
  const unreadable = (reason) => ({ state: 'unreadable', appUnique, reason });
  try {
    if (typeof sdk.resolveArtifact !== 'function') return unreadable('the SDK has no app lookup');
    const found = await sdk.resolveArtifact('app', { uniqueName: appUnique });
    if (!Array.isArray(found)) return unreadable('the app lookup answered no list');
    if (!found.length) return { state: 'absent', appUnique };
    const appId = found[0] && typeof found[0].id === 'string' ? found[0].id.trim() : '';
    if (!appId) return unreadable('the app lookup answered a row with no id');
    if (!sdk.dataverse || typeof sdk.dataverse.get !== 'function') return unreadable('SDK dataverse reader is unavailable');
    const rows = await collectionRows(sdk.dataverse, associationPath(appId, ['roleid', 'name', 'ismanaged']), 'the association rows');
    const roles = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.roleid !== 'string' || !row.roleid) return unreadable('an association row names no role');
      roles.push({ roleId: row.roleid.toLowerCase(), name: typeof row.name === 'string' ? row.name : '', managed: row.ismanaged === true });
    }
    roles.sort((a, b) => compareText(a.name, b.name) || compareText(a.roleId, b.roleId));
    return { state: 'read', appUnique, appId, roles };
  } catch (err) {
    return unreadable(err && err.statusCode ? `HTTP ${err.statusCode}` : reasonOf(err));
  }
}

module.exports = { appIdFor, appRoleIdsFor, appRolesOf };

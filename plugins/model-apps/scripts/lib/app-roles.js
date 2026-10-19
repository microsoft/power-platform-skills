'use strict';
// What the environment says about who can OPEN a model-driven app: the security roles associated with it — the N:N `appmoduleroles` relationship, the
// rows the app launcher reads to decide which apps a user without a maker-level role sees. READ-ONLY: nothing here writes, and every failure is an
// answer ({ ok: false, reason } / { state: 'unreadable' }), never a throw, because both callers report what they could not read instead of failing on it.
//
//   verify-model-app.js  appIdFor / appRoleIdsFor — the ids of the roles a deployed app has, to prove the app is associated with the roles its personas author.
//   write-app-spec-doc.js  appRolesOf — the roles (by name) an app has, for the design document: an extension of an app that already has roles
//                          says nothing about them in its spec, and the document is where a reviewer is told what they are.
//
// Two lookups of the app, kept as they were. verify checks the app as it is DEPLOYED and asks `queryRecords('appmodule')`, as it always did. The
// document is written BEFORE the build, to say what the build will do, so it asks the question the build asks: `findArtifact('app', { uniqueName })`, the
// probe the build and its dry run use to choose between creating the app and reusing it. Both read the PUBLISHED layer (the build publishes the app
// when it creates it, because a draft answers 404 by id and no probe sees it), so "absent" here is exactly "the build would create it".
//
// The relationship is read directly (`GET /appmodules(<id>)/appmoduleroles_association`): the SDK has associate and disassociate helpers for it
// and no modeled read. A read that fails — HTTP 403 for a user who may not read roles, 404 for an app with no published row — is reported as unreadable,
// which the document words as "not checked", never as "no roles".
// See: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appmodule
//      https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/share-model-driven-app
const { odataLit } = require('./odata.js');
const { compareText } = require('./compare-text.js');

// A failure as the one line a caller shows: the message, cut at 200 characters (an error text can carry a whole response body).
const reasonOf = (err) => ((err && err.message) ? String(err.message).slice(0, 200) : 'read failed');

// Resolve the app module id from its unique name, in the published layer. Undefined when there is no such app there.
async function appIdFor(sdk, appUnique) {
  const rows = await sdk.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 });
  return rows && rows[0] && rows[0].appmoduleid;
}

// The association rows of an app, with the role columns in `select` (`roleid`, `name`, `ismanaged`: the navigation property answers role rows).
//   { ok: true, rows }  — `rows` as the platform answered them (not checked: a caller that needs a list checks it)
//   { ok: false, reason }
// `appId` is trusted to be a GUID the platform gave: callers get it from a lookup of their own, never from a spec.
async function readAppRoleRows(sdk, appId, select) {
  try {
    if (!sdk.dataverse || typeof sdk.dataverse.get !== 'function') return { ok: false, reason: 'SDK dataverse reader is unavailable' };
    const res = await sdk.dataverse.get(`/appmodules(${appId})/appmoduleroles_association?$select=${select.join(',')}`);
    if (!res || res.status < 200 || res.status >= 300) return { ok: false, reason: `HTTP ${res && res.status}` };
    return { ok: true, rows: (res.body && res.body.value) || [] };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

// verify's view: the ids of the roles the deployed app has, lower-cased, so verify proves the app<->role rows the launcher uses rather than inferring
// access from a role's existence or from the build's result. { ok: true, roleIds } | { ok: false, reason }.
async function appRoleIdsFor(sdk, appUnique) {
  try {
    const appId = await appIdFor(sdk, appUnique);
    if (!appId) return { ok: false, reason: `app '${appUnique}' could not be resolved` };
    const read = await readAppRoleRows(sdk, appId, ['roleid']);
    if (!read.ok) return { ok: false, reason: read.reason };
    return {
      ok: true,
      roleIds: read.rows
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
 *   { state: 'absent', appUnique }                                            no app has that unique name, so a build creates it
 *   { state: 'unreadable', appUnique, reason }                                the app or its roles could not be read: nothing is known about them
 * A row with no role id is skipped (it names no role); a role with no name is listed with the empty one.
 * @param {object} sdk the bundled SDK (lib/maker-sdk.js)
 * @param {string} appUnique the app's unique name
 */
async function appRolesOf(sdk, appUnique) {
  try {
    if (typeof sdk.findArtifact !== 'function') return { state: 'unreadable', appUnique, reason: 'the SDK has no app lookup' };
    const found = await sdk.findArtifact('app', { uniqueName: appUnique });
    if (!found) return { state: 'absent', appUnique };
    const appId = String(found);
    const read = await readAppRoleRows(sdk, appId, ['roleid', 'name', 'ismanaged']);
    if (!read.ok) return { state: 'unreadable', appUnique, reason: read.reason };
    const roles = (Array.isArray(read.rows) ? read.rows : [])
      .filter((row) => row && typeof row.roleid === 'string' && row.roleid)
      .map((row) => ({ roleId: row.roleid.toLowerCase(), name: typeof row.name === 'string' ? row.name : '', managed: row.ismanaged === true }))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.roleId, b.roleId));
    return { state: 'read', appUnique, appId, roles };
  } catch (err) {
    return { state: 'unreadable', appUnique, reason: reasonOf(err) };
  }
}

module.exports = { appIdFor, appRoleIdsFor, readAppRoleRows, appRolesOf };

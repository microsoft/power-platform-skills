'use strict';
// What an App Spec says about two different questions the plugin used to answer as one ("no personas[] → the app opens only for administrators", AB#6770008):
//
//   1. Who can open the APP? The security roles ASSOCIATED WITH THE APP (the `appmoduleroles` relationship) decide which users see it in the app list.
//      The build writes that association in exactly two places: the SDK gives a NEW app the System Administrator role when it creates it, and the security
//      phase associates each persona's role (unless `appAccess: false`). It never changes the roles of an app that already exists, other than for the
//      personas it authors. So a spec with no personas[] says nothing about who can open an app that already exists — and the spec alone cannot say whether
//      the app exists (existingAppMarkers).
//   2. Who can use a TABLE? Privileges, from personas[] (roles the spec owns: the build converges them to exactly the declared set, and refuses a role it did
//      not author) and roleGrants[] (privileges ADDED to roles it does not own — which does not associate the role with the app). A table the spec creates is
//      held by no role it does not grant it to.
//
// A user needs both: a role associated with the app to open it, and privileges on a table in a role to work with that table's records in it, as
// https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/share-model-driven-app says. Users with a maker-level role (System Administrator,
// System Customizer, Environment Maker) can open every app without an association: https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/app-visibility-privileges
//
// PURE: no I/O. The lint (spec-lint.js), the design document (app-spec-doc.js) and its warnings (write-app-spec-doc.js) all read the spec through here,
// so they cannot disagree about which tables nothing grants, or which marks say an app already exists. The environment's side — the roles an app
// has — is read by lib/app-roles.js and arrives here as `appAccess`.
const { canonicalPersonaName } = require('./app-spec.js');

// Every collection read here is shape-guarded: the lint and the document run on specs still being typed, and a crash kills the authoring flow.
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const lc = (s) => String(s || '').toLowerCase();
const filled = (v) => typeof v === 'string' && v.trim() !== '';

// "a", "a and b", "a, b and c".
function list(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * What the spec carries that a download writes, and a spec for a new app does not: the app's own unique name (`app.uniqueName` — "download-emitted" in
 * references/app-spec-schema.md; an authored create-fresh spec omits it), and the ids of its pages and dashboards (`pages[].pageId`, `dashboards[].dashboardId`:
 * an edit-snapshot's). Each is named once, in this order. They say the spec was DOWNLOADED from an app, which is why callers say "most likely": a copy of
 * a downloaded spec can be built into an environment that does not have the app. An EMPTY list does not mean the app is new either — a hand-written spec for an
 * app that exists carries none of them — so a caller words what it says without them as a condition.
 * @returns {string[]}
 */
function existingAppMarkers(spec) {
  const s = isObject(spec) ? spec : {};
  const marks = [];
  if (isObject(s.app) && filled(s.app.uniqueName)) marks.push('app.uniqueName');
  if (arr(s.pages).some((p) => isObject(p) && filled(p.pageId))) marks.push('pages[].pageId');
  if (arr(s.dashboards).some((d) => isObject(d) && filled(d.dashboardId))) marks.push('dashboards[].dashboardId');
  return marks;
}

/** The tables the spec creates: entities[] not marked `existing: true` (a download marks every table it recovers), by the schemaName they were written with. */
function introducedTables(spec) {
  return arr(isObject(spec) ? spec.entities : []).filter((e) => isObject(e) && filled(e.schemaName) && e.existing !== true).map((e) => e.schemaName);
}

/**
 * Every privilege the spec declares on a table, by the table's logical name (lower case):
 *   Map { 'contoso_baseline' → [ { via: 'persona' | 'roleGrant', role, access, scope } ] }
 * from personas[].jobs[].privileges, personas[].additionalPrivileges and roleGrants[].privileges, personas first. `role` is the persona's name, or the
 * grant's role name (its id when it names the role by id). A privilege that grants nothing — no table, no access — is not a source. `scope` defaults to
 * `user`, as it does in the spec.
 * @returns {Map<string, { via: string, role: string, access: string[], scope: string }[]>}
 */
function tablePrivileges(spec) {
  const s = isObject(spec) ? spec : {};
  const sources = new Map();
  const add = (privilege, via, role) => {
    if (!isObject(privilege) || !filled(privilege.entity)) return;
    const access = arr(privilege.access).filter((a) => typeof a === 'string' && a);
    if (!access.length) return;
    const key = lc(privilege.entity.trim());
    if (!sources.has(key)) sources.set(key, []);
    sources.get(key).push({ via, role, access, scope: filled(privilege.scope) ? privilege.scope : 'user' });
  };
  for (const persona of arr(s.personas)) {
    if (!isObject(persona)) continue;
    const name = canonicalPersonaName(persona);
    const role = typeof name === 'string' ? name : '';
    for (const job of arr(persona.jobs)) {
      if (isObject(job)) for (const privilege of arr(job.privileges)) add(privilege, 'persona', role);
    }
    for (const privilege of arr(persona.additionalPrivileges)) add(privilege, 'persona', role);
  }
  for (const grant of arr(s.roleGrants)) {
    if (!isObject(grant)) continue;
    const role = filled(grant.role) ? grant.role.trim() : (filled(grant.roleId) ? grant.roleId.trim() : '');
    for (const privilege of arr(grant.privileges)) add(privilege, 'roleGrant', role);
  }
  return sources;
}

/** The introduced tables no persona and no roleGrants[] entry grants a privilege on, once each, in the order the spec lists them. */
function uncoveredTables(spec) {
  const covered = tablePrivileges(spec);
  const seen = new Set();
  return introducedTables(spec).filter((name) => {
    const key = lc(name.trim());
    if (seen.has(key)) return false;
    seen.add(key);
    return !covered.has(key);
  });
}

// --- what the lint and the document say ---------------------------------------------------------------------------------------------------

/**
 * Who can open the app, as far as the SPEC can say: the sentence the lint and the document share for a spec with no personas[]. With a mark of an
 * existing app it says the spec edits one and leaves its roles alone; without one it is a condition — nothing in a spec proves the app is new.
 */
function appAccessCondition(spec) {
  const marks = existingAppMarkers(spec);
  if (marks.length) {
    return `It carries ${list(marks)}, which a download writes, so it most likely edits an app that already exists — and a build leaves the roles associated with an existing app as they are: who can open the app is decided by the environment, not by this spec.`;
  }
  return 'If the app is new, it is associated with the System Administrator role only, so users without a maker-level role cannot open it until a role is associated with it (personas[] does that); if it already exists, it keeps the roles it has.';
}

/** The lint's warning for a spec with no personas[]: the jobs are not recorded, no role is authored, and what that does and does not say about access. */
function noPersonasWarning(spec) {
  const advice = existingAppMarkers(spec).length
    ? 'Add personas[] only for roles this spec should own (a persona\'s role is converged to exactly the privileges declared, and the build refuses a role it did not author); to give an existing role access to a new table, add a roleGrants[] entry.'
    : 'Capture who uses this app and what each of them needs to get done; to give an existing role access to a new table without redefining the role, add a roleGrants[] entry instead of a persona.';
  return `no personas[] — no jobs-to-be-done are recorded and this spec authors no security role. ${appAccessCondition(spec)} ${advice}`;
}

// The table names a sentence shows: up to five, then a count.
function tableNames(names, quote) {
  const shown = names.slice(0, 5).map((n) => `${quote}${n}${quote}`);
  return list(names.length > 5 ? [...shown, `${names.length - 5} more`] : shown);
}

/** The warning (lint and design gaps) for new tables nothing grants a privilege on. `names` is uncoveredTables(spec), not empty. */
function uncoveredTablesWarning(names) {
  const one = names.length === 1;
  const it = one ? 'it' : 'them';
  const subject = one ? `new table ${tableNames(names, "'")} has` : `${names.length} new tables (${tableNames(names, "'")}) have`;
  return `${subject} no access declared: no persona job or additionalPrivileges entry and no roleGrants[] entry grants a privilege on ${it}, so a user of a role that already exists cannot use ${it} until a grant is made. Add a roleGrants[] entry for each existing role that needs ${it} (it only adds privileges), or declare the access on a persona's job.`;
}

/** The design document's callout for the same tables (the heading it sits under says "no access declared"). */
function uncoveredTablesCallout(names) {
  const one = names.length === 1;
  const it = one ? 'it' : 'them';
  const subject = one ? `${tableNames(names, '`')} is` : `${tableNames(names, '`')} are`;
  return `${subject} introduced by this spec, but no persona and no \`roleGrants[]\` entry grants a privilege on ${it}, so a user of a role that already exists cannot use ${it} until a grant is made. Add a \`roleGrants[]\` entry for each existing role that needs ${it} (it only adds privileges), or declare the access on a persona's job.`;
}

// --- what the environment says ----------------------------------------------------------------------------------------------------------------

/**
 * What a read of the environment (lib/app-roles.js `appRolesOf`) means for this spec — one model for the document and its warnings.
 *   { state: 'unread' }                                       the environment was not asked (no --env), or the answer is not one this knows
 *   { state: 'absent', appUnique }                            the app does not exist yet: a build creates it
 *   { state: 'unreadable', appUnique, reason }                nothing is known of its roles
 *   { state: 'read', appUnique, roles, missingGrantRoles }    `roles`: { roleId, name, managed, source } with `source` 'persona' (the spec authors it), 'roleGrant'
 *                                                             (the spec extends it) or null (it touches neither); `missingGrantRoles`: the roleGrants[] roles that are
 *                                                             not among the app's, by the label they are written with
 * A role is matched to a persona or a grant by name in any letter case, and a grant also by id. Names are all the answer has of a role in a business unit,
 * so a match by name is a match of names, and the wording that depends on it says "may".
 */
function appAccessModel(spec, appAccess) {
  if (!isObject(appAccess)) return { state: 'unread' };
  const appUnique = typeof appAccess.appUnique === 'string' ? appAccess.appUnique : '';
  if (appAccess.state === 'absent') return { state: 'absent', appUnique };
  if (appAccess.state === 'unreadable') return { state: 'unreadable', appUnique, reason: filled(appAccess.reason) ? appAccess.reason : 'unknown' };
  if (appAccess.state !== 'read') return { state: 'unread' };
  if (!Array.isArray(appAccess.roles)) return { state: 'unreadable', appUnique, reason: 'the answer held no list of roles' };

  const s = isObject(spec) ? spec : {};
  const personaNames = new Set(arr(s.personas).filter(isObject).map((p) => lc(canonicalPersonaName(p))).filter(Boolean));
  const grants = arr(s.roleGrants).filter(isObject).map((g) => ({
    name: filled(g.role) ? lc(g.role.trim()) : '',
    id: filled(g.roleId) ? lc(g.roleId.trim()) : '',
    label: filled(g.role) ? g.role.trim() : (filled(g.roleId) ? g.roleId.trim() : ''),
  })).filter((g) => g.label);
  const roles = appAccess.roles.filter(isObject).map((r) => {
    const name = typeof r.name === 'string' ? r.name : '';
    const roleId = typeof r.roleId === 'string' ? r.roleId : '';
    const granted = grants.some((g) => (g.id && g.id === lc(roleId)) || (g.name && g.name === lc(name)));
    return { roleId, name, managed: r.managed === true, source: personaNames.has(lc(name)) && name ? 'persona' : (granted ? 'roleGrant' : null) };
  });
  const ids = new Set(roles.map((r) => lc(r.roleId)).filter(Boolean));
  const names = new Set(roles.map((r) => lc(r.name)).filter(Boolean));
  const missingGrantRoles = grants.filter((g) => !((g.id && ids.has(g.id)) || (g.name && names.has(g.name)))).map((g) => g.label);
  return { state: 'read', appUnique, roles, missingGrantRoles };
}

module.exports = {
  existingAppMarkers,
  introducedTables,
  tablePrivileges,
  uncoveredTables,
  appAccessCondition,
  noPersonasWarning,
  uncoveredTablesWarning,
  uncoveredTablesCallout,
  appAccessModel,
};

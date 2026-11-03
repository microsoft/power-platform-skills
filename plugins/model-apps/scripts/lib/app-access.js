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
const { canonicalPersonaName, roleGrantEntryLabel, roleGrantIdentityErrors } = require('./app-spec.js');

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

/**
 * The roleGrants[] entries the build refuses because they do not name exactly one role — `role` and `roleId` both, neither, or one of them
 * malformed — each with the gate's own messages (app-spec.js roleGrantIdentityErrors, which validateRoleGrants reports and lint-app-spec.js
 * prints as `schema:` errors), labelled by the entry's index as written:
 *   [ { index, messages: ["roleGrants[1] (role \"Viewer\"): set either 'role' … or 'roleId' …, not both — …"] } ]
 * The document shows these instead of the entry's privileges, and does not match them against the roles of the app.
 * @returns {{ index: number, messages: string[] }[]}
 */
function roleGrantRefusals(spec) {
  const out = [];
  arr(isObject(spec) ? spec.roleGrants : []).forEach((g, index) => {
    if (!isObject(g)) return;
    const messages = roleGrantIdentityErrors(g, roleGrantEntryLabel(g, index));
    if (messages.length) out.push({ index, messages });
  });
  return out;
}

// --- the personas' share of who can open the app ----------------------------------------------------------------------------------------------

/**
 * Which personas get the app and which opt out, by the names their roles are made with (the canonical, trimmed ones: once each, in any letter case, in spec
 * order). The build associates a persona's role with the app unless `appAccess` is `false`, and REMOVES the association of a role whose persona opts out — sdk-build.js,
 * the security phase: `persona.appAccess !== false`, else the dissociate. So "this spec authors roles" is not "this spec gives the app to roles": every sentence about
 * what a build associates follows this, not whether there are personas.
 * @returns {{ gets: string[], optedOut: string[] }}
 */
function personaAppAccess(spec) {
  const out = { gets: [], optedOut: [] };
  const seen = new Set();
  for (const p of arr(isObject(spec) ? spec.personas : [])) {
    if (!isObject(p)) continue;
    const name = canonicalPersonaName(p);
    if (!filled(name) || seen.has(lc(name))) continue;
    seen.add(lc(name));
    (p.appAccess === false ? out.optedOut : out.gets).push(name);
  }
  return out;
}

// "the role of persona `A`", "the roles of personas `A` and `B`".
function rolesOfPersonas(names) {
  const many = names.length > 1;
  return `the role${many ? 's' : ''} of persona${many ? 's' : ''} ${list(names.map((n) => `\`${n}\``))}`;
}

// --- what the lint and the document say ---------------------------------------------------------------------------------------------------

/**
 * Who can open the app, as far as the SPEC can say: first what a build does for the personas (their roles get the app, or lose it), then what it leaves to the
 * environment — the sentence the lint (a spec with no personas) and the document (an answer from the environment that is missing or unreadable) share. With a mark
 * of an existing app it says the spec most likely edits one, whose other roles a build leaves alone; without one it is a condition — nothing in a spec proves the app
 * is new.
 */
function appAccessCondition(spec) {
  const { gets, optedOut } = personaAppAccess(spec);
  const marks = existingAppMarkers(spec);
  const hasPersonas = gets.length > 0 || optedOut.length > 0;
  let personas = '';
  if (gets.length && optedOut.length) personas = `A build associates the app with ${rolesOfPersonas(gets)}, and removes it from ${rolesOfPersonas(optedOut)} (\`appAccess: false\`) if it has it.`;
  else if (gets.length) personas = `A build associates the app with ${rolesOfPersonas(gets)}.`;
  else if (optedOut.length) personas = `No persona gets the app: a build removes the app from ${rolesOfPersonas(optedOut)} (\`appAccess: false\`) if it has it.`;
  let rest;
  if (marks.length) {
    const download = `It carries ${list(marks)}, which a download writes, so it most likely edits an app that already exists — and a build`;
    rest = hasPersonas
      ? `${download} changes the roles associated with an existing app only for its personas: who else can open the app is decided by the environment, not by this spec.`
      : `${download} leaves the roles associated with an existing app as they are: who can open the app is decided by the environment, not by this spec.`;
  } else {
    rest = hasPersonas
      ? 'Beyond that, a new app is associated with the System Administrator role only, and an existing app keeps the roles it has.'
      : 'If the app is new, it is associated with the System Administrator role only, so users without a maker-level role cannot open it until a role is associated with it (personas[] does that); if it already exists, it keeps the roles it has.';
  }
  return personas ? `${personas} ${rest}` : rest;
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
 * What a read of the environment (lib/app-roles.js `appRolesOf`) means for this spec — ONE model, from which the document and its warnings take every sentence, so
 * that what they say of who gets the app, of which role is which and of whether the app is administrator-only cannot differ.
 *   { state: 'unread', personas }                          the environment was not asked (no --env), or the answer is not one this knows
 *   { state: 'absent', appUnique, personas }               neither layer has the app: a build creates it
 *   { state: 'unreadable', appUnique, reason, personas }   nothing is known of its roles — a refusal, an answer that holds no list, a row that names no role
 *   { state: 'read', appUnique, personas, roles, grants }  what the app has
 * `personas` is personaAppAccess(spec): the personas that get the app and those that opt out.
 * `roles`: { roleId, name, managed, sources }, one per associated role, in the order of the answer. `sources` says what in the spec may be that role:
 *     { kind: 'roleGrant', label, by: 'id', certain: true }      a roleGrants[] entry that names this role's id: the one case it IS the role the grant extends
 *     { kind: 'roleGrant', label, by: 'name', certain: false }   an entry that names only a name — a role is one of (name, business unit), the answer carries no business
 *                                                                unit, and the build resolves the grant's role by name AND business unit, so any role of that name may be it
 *     { kind: 'persona', label, getsApp, certain: false }        a persona of that name: its role is made in the persona's business unit, so it too is matched by name only
 *   `getsApp` is what the persona asks of the app; the build keeps the association of one that gets it and removes that of one that opts out.
 * `grants`: one per roleGrants[] entry that names a role, { label, by: 'id' | 'name', status, candidates: [{ roleId, name }] }. `status`:
 *     'associated'      named by id, and that role is associated with the app — certain
 *     'maybe'           named by name, and every candidate has that name: which of them (if any) is the grant's role the answer cannot say
 *     'not-associated'  no associated role has that id (or that name) — certain: such a grant gives its role the table, not the app
 * A role is never claimed as a grant's or a persona's by a match of names alone. A match by id is exact, and a grant that gives an id is matched by it alone.
 */
function appAccessModel(spec, appAccess) {
  const personas = personaAppAccess(spec);
  if (!isObject(appAccess)) return { state: 'unread', personas };
  const appUnique = typeof appAccess.appUnique === 'string' ? appAccess.appUnique : '';
  if (appAccess.state === 'absent') return { state: 'absent', appUnique, personas };
  if (appAccess.state === 'unreadable') return { state: 'unreadable', appUnique, reason: filled(appAccess.reason) ? appAccess.reason : 'unknown', personas };
  if (appAccess.state !== 'read') return { state: 'unread', personas };
  // An answer is a list of roles, every one of them a role: a list that is none, or has a row that names no role, is not read as a list with nothing in it.
  if (!Array.isArray(appAccess.roles)) return { state: 'unreadable', appUnique, reason: 'the answer held no list of roles', personas };
  if (appAccess.roles.some((r) => !isObject(r) || !filled(r.roleId))) return { state: 'unreadable', appUnique, reason: 'an association row names no role', personas };

  const s = isObject(spec) ? spec : {};
  const named = arr(s.personas).filter(isObject)
    .map((p) => ({ name: canonicalPersonaName(p), getsApp: p.appAccess !== false }))
    .filter((p) => filled(p.name));
  // An entry the build refuses names no role it would extend (roleGrantRefusals), so it is matched to none of the app's.
  const refused = new Set(roleGrantRefusals(s).map((r) => r.index));
  const wanted = arr(s.roleGrants).map((g, index) => {
    if (!isObject(g) || refused.has(index)) return null;
    if (filled(g.roleId)) return { by: 'id', key: lc(g.roleId.trim()), label: g.roleId.trim() };
    if (filled(g.role)) return { by: 'name', key: lc(g.role.trim()), label: g.role.trim() };
    return null;
  }).filter(Boolean);
  const isTarget = (grant, role) => (grant.by === 'id' ? grant.key === lc(role.roleId) : grant.key === lc(role.name));

  const roles = appAccess.roles.map((r) => {
    const role = { roleId: r.roleId, name: typeof r.name === 'string' ? r.name : '' };
    const sources = [];
    for (const grant of wanted) {
      if (isTarget(grant, role)) sources.push({ kind: 'roleGrant', label: grant.label, by: grant.by, certain: grant.by === 'id' });
    }
    for (const persona of named) {
      if (role.name && lc(persona.name) === lc(role.name)) sources.push({ kind: 'persona', label: persona.name, getsApp: persona.getsApp, certain: false });
    }
    return { ...role, managed: r.managed === true, sources };
  });
  const grants = wanted.map((grant) => {
    const candidates = roles.filter((role) => isTarget(grant, role)).map((role) => ({ roleId: role.roleId, name: role.name }));
    const status = !candidates.length ? 'not-associated' : (grant.by === 'id' ? 'associated' : 'maybe');
    return { label: grant.label, by: grant.by, status, candidates };
  });
  return { state: 'read', appUnique, personas, roles, grants };
}

module.exports = {
  existingAppMarkers,
  introducedTables,
  tablePrivileges,
  uncoveredTables,
  roleGrantRefusals,
  personaAppAccess,
  rolesOfPersonas,
  appAccessCondition,
  noPersonasWarning,
  uncoveredTablesWarning,
  uncoveredTablesCallout,
  appAccessModel,
};

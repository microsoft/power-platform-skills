// plugins/model-apps/scripts/lib/role-privileges.js
// PURE: what privileges a persona's security role MUST hold, and whether a deployed role holds them.
//
// WHY this exists. `verifySpec`'s role check proved only that a role ROW exists carrying the SDK
// ownership marker. It never looked at the role's privileges — so a role created with the wrong
// access, or one whose privilege write silently failed after the row was created, verified clean.
// That is a metadata read, which is why it is cheap enough to run on every verify.
//// SUBSET, not equality. We assert the role holds AT LEAST every declared privilege at AT LEAST the
// declared depth. Extra privileges are never a finding, and that is deliberate — three legitimate
// sources add privileges the spec does not literally list:
//   1. `appAccess` injects `appmodule` read (see personaRoleSpecFor).
//   2. Several jobs unioned together escalate a shared entity+access to the MAX declared scope.
//   3. Distinct entities can share ONE Dataverse privilege, and a role holds one depth per
//      privilege — so the SDK raises that privilege to the highest scope any of them asked for.
// An equality check would fail on all three while telling us nothing true.
//
// Dataverse reference — privilege depth (`Depth` on ReplacePrivilegesRole, `RolePrivilegeDepth`):
// Basic (user) < Local (business unit) < Deep (parent/child) < Global (organization).
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/security-model
'use strict';

// App Spec scope -> Dataverse depth name, and its ORDER. The order is what makes this a subset
// check: a role holding Global satisfies a declared Basic. Mirrors the vendored SDK's own mapping
// (verified against scripts/vendor/cds-maker-sdk.cjs) so a comparison cannot disagree with the write.
const SCOPE_DEPTH = { user: 'Basic', businessUnit: 'Local', parentChild: 'Deep', organization: 'Global' };
const DEPTH_RANK = { basic: 1, local: 2, deep: 3, global: 4 };
// App Spec access token -> Dataverse PrivilegeType, again mirroring the SDK.
// KEYS ARE LOWERCASE because the lookup lowercases (`ACCESS_TYPE[d.access.toLowerCase()]`). The
// camelCase `appendTo` spelling the App Spec uses therefore has to appear here as `appendto`; keying
// it `appendTo` made the lookup return undefined and reported every declared appendTo privilege as
// "'<entity>' exposes no 'appendTo' privilege" — a false failure on a correctly granted role, which
// is the cry-wolf outcome this whole check exists to avoid.
const ACCESS_TYPE = { read: 'Read', create: 'Create', write: 'Write', delete: 'Delete', append: 'Append', appendto: 'AppendTo', assign: 'Assign', share: 'Share' };

const rankOf = (depth) => DEPTH_RANK[String(depth == null ? '' : depth).trim().toLowerCase()] || 0;

// `roleprivileges.privilegedepthmask` -> the depth NAME the comparison speaks in.
//
// The column is a BITMASK, not an enum: 1 Basic, 2 Local, 4 Deep, 8 Global. A single value can
// therefore carry SEVERAL bits — 3 (Basic|Local), 7 (Basic|Local|Deep), 15 (all four) are all legal
// — because privilege depth is CUMULATIVE: a role granted Global can also do everything Basic
// allows. The effective depth is therefore the HIGHEST bit set, never an exact match.
//
// An exact-match lookup (`{1:'Basic',2:'Local',4:'Deep',8:'Global'}[mask]`) mapped every combined
// value to '', which ranks 0, which made `compareRolePrivileges` report a CORRECTLY configured role
// as missing or too shallow — the cry-wolf failure this check exists to avoid.
//
// Fail closed on 0, a negative, a non-number, or a value carrying only bits we do not recognise:
// an undecodable mask is not evidence of a grant.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/roleprivileges
function depthFromMask(mask) {
  const m = Number(mask);
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m & 8) return 'Global';
  if (m & 4) return 'Deep';
  if (m & 2) return 'Local';
  if (m & 1) return 'Basic';
  return '';
}

// Flatten a persona to the (entity, access, scope) triples its role must satisfy, taking the MAX
// scope per (entity, access) exactly as the builder's union does. `appAccess` is folded in here so
// the expectation matches what the build actually writes rather than what the author typed.
function declaredPrivileges(persona) {
  const byKey = new Map(); // "<entity>|<access>" -> { entity, access, scope }
  const addAll = (list) => {
    for (const pr of list || []) {
      if (!pr || !pr.entity) continue;
      const entity = String(pr.entity).trim().toLowerCase();
      const scope = pr.scope || 'user';
      for (const a of pr.access || []) {
        const access = String(a).trim();
        if (!access) continue;
        const key = `${entity}|${access.toLowerCase()}`;
        const prev = byKey.get(key);
        // Max scope wins — the same rule the builder applies when unioning jobs into one role.
        if (!prev || rankOf(SCOPE_DEPTH[scope]) > rankOf(SCOPE_DEPTH[prev.scope])) byKey.set(key, { entity, access, scope });
      }
    }
  };
  for (const j of (persona && persona.jobs) || []) addAll(j && j.privileges);
  addAll(persona && persona.additionalPrivileges);
  // Mirrors personaRoleSpecFor: unless the persona opts out, the build grants appmodule read so the
  // app actually opens for them. Verifying it matters — without it the role exists but the app does not.
  if (!persona || persona.appAccess !== false) addAll([{ entity: 'appmodule', access: ['read'], scope: 'organization' }]);
  return [...byKey.values()];
}

// Compare declared privileges against what the role actually holds.
//   `entityPrivileges`: Map<entityLogical, [{ Name, PrivilegeId, PrivilegeType }]> — from
//                       EntityDefinitions(LogicalName='x')?$select=Privileges, the SAME source the
//                       SDK resolves against when it writes.
//   `actualByPrivilegeId`: Map<privilegeId(lowercased), depthName>
// Returns { ok, missing:[{ entity, access, scope, reason, privilegeName? }] }.
// An entity whose metadata could not be read is reported as a finding, never skipped — a read
// failure must not read as "nothing missing" (fail closed).
function compareRolePrivileges(declared, entityPrivileges, actualByPrivilegeId) {
  const missing = [];
  for (const d of declared) {
    const privs = entityPrivileges.get(d.entity);
    if (!privs) {
      missing.push({ ...d, reason: `could not read privilege metadata for '${d.entity}'` });
      continue;
    }
    const type = ACCESS_TYPE[d.access.toLowerCase()];
    const p = type && privs.find((x) => x && x.PrivilegeType === type);
    if (!p) {
      missing.push({ ...d, reason: `'${d.entity}' exposes no '${d.access}' privilege` });
      continue;
    }
    const held = actualByPrivilegeId.get(String(p.PrivilegeId || '').trim().toLowerCase());
    if (!held) {
      missing.push({ ...d, privilegeName: p.Name, reason: `role does not hold ${p.Name}` });
      continue;
    }
    const want = SCOPE_DEPTH[d.scope] || 'Basic';
    if (rankOf(held) < rankOf(want)) {
      missing.push({ ...d, privilegeName: p.Name, reason: `role holds ${p.Name} at ${held}, below the declared ${want}` });
    }
  }
  return { ok: missing.length === 0, missing };
}

// The privilege set a role holds after the SDK writes `requests` into it — EXACTLY, not as a subset: what the explicit managed
// download proves before it writes a persona read from a role (lib/persona-restore.js), because a build REPLACES a persona
// role's privileges with this set (ReplacePrivilegesRole), so a persona that compiles to anything else changes the role.
//   `requests`: [{ entity, access: [...], scope? }] — a PersonaRoleSpec's job privileges and additionalPrivileges, flattened
//               as the SDK flattens them (createPersonaRole).
//   `entityPrivileges`: Map<entityLogical, [{ name, privilegeId, privilegeType, scopes }]> — the SDK's own
//               `getEntityPrivileges` answer, whose `scopes` lists the App Spec scopes the privilege's CanBe* flags allow.
// Returns Map<privilegeId(lowercased, unbraced), { name, depth }> with `depth` the Dataverse depth name.
//
// Mirrors the vendored SDK's resolver (scripts/vendor/cds-maker-sdk.cjs, the function createSecurityRole compiles with)
// rule for rule, and THROWS where it throws, so a set it would refuse is never called exact:
//   * a missing scope is `user`; an unknown scope, an empty access list, an unknown access or one the table does not
//     expose is refused;
//   * a scope the privilege's CanBe* flag forbids is refused;
//   * one entry per PrivilegeId. The same scope again joins the entity to it. A different scope is allowed only when
//     the entry so far came from this one entity, and then the higher scope wins; distinct entities sharing a
//     privilege at different scopes are refused (a role holds one depth per privilege).
// Access tokens are matched through ACCESS_TYPE (lower-cased keys), so `appendto` is read as `appendTo` here where the
// SDK would refuse it; the App Spec validator and the download only ever produce the SDK's own spelling.
function compileRolePrivileges(requests, entityPrivileges) {
  const byId = new Map();
  for (const r of requests || []) {
    const entity = String((r && r.entity) || '');
    if (!r || !Array.isArray(r.access) || !r.access.length) throw new Error(`'${entity}' asks for no access`);
    const scope = r.scope === undefined || r.scope === null ? 'user' : r.scope;
    if (!Object.prototype.hasOwnProperty.call(SCOPE_DEPTH, scope)) throw new Error(`unknown scope '${scope}' for '${entity}'`);
    const privs = entityPrivileges.get(entity);
    if (!Array.isArray(privs) || !privs.length) throw new Error(`the privileges of '${entity}' are not known`);
    for (const a of r.access) {
      const type = Object.prototype.hasOwnProperty.call(ACCESS_TYPE, String(a).toLowerCase()) ? ACCESS_TYPE[String(a).toLowerCase()] : undefined;
      if (!type) throw new Error(`unknown access '${a}' for '${entity}'`);
      const p = privs.find((x) => x && x.privilegeType === type);
      if (!p) throw new Error(`'${entity}' does not support '${a}' access`);
      if (!Array.isArray(p.scopes) || !p.scopes.includes(scope)) throw new Error(`privilege '${p.name}' on '${entity}' does not support the '${scope}' scope`);
      const id = String(p.privilegeId || '').replace(/[{}]/g, '').trim().toLowerCase();
      const prev = byId.get(id);
      if (!prev) { byId.set(id, { name: p.name, scope, entities: new Set([entity]) }); continue; }
      if (prev.scope === scope) { prev.entities.add(entity); continue; }
      if (!(prev.entities.size === 1 && prev.entities.has(entity))) {
        throw new Error(`'${[...prev.entities].sort().join(', ')}' and '${entity}' share the privilege '${p.name}' at different scopes`);
      }
      if (rankOf(SCOPE_DEPTH[scope]) > rankOf(SCOPE_DEPTH[prev.scope])) prev.scope = scope;
    }
  }
  return new Map([...byId].map(([id, v]) => [id, { name: v.name, depth: SCOPE_DEPTH[v.scope] }]));
}

module.exports = { declaredPrivileges, compareRolePrivileges, compileRolePrivileges, depthFromMask, SCOPE_DEPTH, ACCESS_TYPE, DEPTH_RANK };

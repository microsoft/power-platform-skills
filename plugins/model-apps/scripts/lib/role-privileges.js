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
const ACCESS_TYPE = { read: 'Read', create: 'Create', write: 'Write', delete: 'Delete', append: 'Append', appendTo: 'AppendTo', assign: 'Assign', share: 'Share' };

const rankOf = (depth) => DEPTH_RANK[String(depth == null ? '' : depth).trim().toLowerCase()] || 0;

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

module.exports = { declaredPrivileges, compareRolePrivileges, SCOPE_DEPTH, ACCESS_TYPE, DEPTH_RANK };

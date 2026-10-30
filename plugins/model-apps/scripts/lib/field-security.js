'use strict';
// Column (field) security: the `isSecured` of a column the table already has, and the field security profiles a spec declares —
// each profile's column permissions and the users and teams it is given to.
//
// What the SDK does and this module relies on (vendored cds-maker-sdk, types/schema.ts and types/fieldSecurityProfile.ts):
//   - createColumn / createColumns send `IsSecured: true` only for `isSecured: true`; createTable REFUSES a secured inline column
//     (the platform answers an opaque 400 for it), which is why the build never secures a column inside a table's create.
//   - updateColumn sends `IsSecured` only when asked; `isSecured: false` first reads which profiles hold a permission on the column
//     and refuses (ArtifactInUseError) when any other than System Administrator does — unsecuring deletes them all.
//   - a field security profile is an artifact: findArtifact('fieldSecurityProfile', { name }) (the name is NOT unique, so an
//     ambiguous one is refused), getArtifact to read it with its permissions, createArtifact + pushArtifact to create it.
//   - who holds a profile is not part of it: associateRecords over systemuserprofiles_association / teamprofiles_association.
// See: https://learn.microsoft.com/power-platform/admin/field-level-security
//
// What the build will NOT do here, on purpose:
//   - change a profile that exists with other permissions, or with a permission the spec does not declare: that is either someone
//     else's profile or a widening the build cannot prove it is entitled to make, so it halts and names the difference;
//   - touch the System Administrator profile, author `readUnmasked`, or infer a user or team from a role or persona;
//   - unsecure a column without the maker's consent for that column (`isSecured:<table>.<column>`): it deletes every permission on it.
// Users WITH the System Administrator security role are exempt from column security; nothing here (or any metadata read) shows
// what a non-administrator can actually see — that is a live check the build cannot make.

const { odataLit } = require('./odata.js');
const { serviceCodeOf } = require('./retry-policy.js');
const { SYSTEM_ADMIN_PROFILE_ID, SYSTEM_ADMIN_PROFILE_NAME, isAuthorized, emptyFeatureResult } = require('./schema-feature-contract.js');

const lower = (v) => String(v == null ? '' : v).toLowerCase();
const KIND = 'fieldSecurityProfile';
// The two N:N relationships a profile is given to users and teams through (fieldsecurityprofile's own relationships).
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/fieldsecurityprofile
const ASSIGNEES = {
  users: { relationshipName: 'systemuserprofiles_association', targetEntity: 'systemuser', key: 'systemuserid' },
  teams: { relationshipName: 'teamprofiles_association', targetEntity: 'team', key: 'teamid' },
};
// The platform's answer to a permission on a column that is not secured; the SDK names it FIELD_SECURITY_COLUMN_NOT_SECURED.
const COLUMN_NOT_SECURED_CODE = '0x8004f508';

// ------------------------------------------------------------------------------------------------------- isSecured on existing columns

// One scalar read of a table's columns and whether each is secured. `IsSecured` is a property of the base AttributeMetadata, a plain
// Edm.Boolean, and no label rides with it:
//   /EntityDefinitions(LogicalName='new_ticket')/Attributes?$select=LogicalName,IsSecured
//   { "value": [ { "LogicalName": "new_salary", "IsSecured": false }, ... ] }
// Made only for a table where the spec declares `isSecured` on a column the table already has; the existing-columns read
// (findExistingColumns) keeps its own narrow select so its request stays what it was.
function columnSecurityPath(table) {
  return `/EntityDefinitions(LogicalName='${odataLit(table)}')/Attributes?$select=LogicalName,IsSecured`;
}

async function readColumnSecurity(provision, table) {
  const raw = provision && provision.dataverse;
  if (!raw || typeof raw.get !== 'function') return { complete: false, reason: 'no metadata reader is available' };
  let res;
  try { res = await raw.get(columnSecurityPath(lower(table))); } catch (e) { return { complete: false, reason: `the read failed${e && e.statusCode ? ` (HTTP ${e.statusCode})` : ''}` }; }
  if (!res || !(res.status >= 200 && res.status < 300)) return { complete: false, reason: `HTTP ${res && res.status}` };
  const body = res.body;
  if (!body || !Array.isArray(body.value) || body['@odata.nextLink']) return { complete: false, reason: 'the answer is not one complete list' };
  const columns = new Map();
  for (const row of body.value) {
    if (row && typeof row.LogicalName === 'string' && typeof row.IsSecured === 'boolean') columns.set(lower(row.LogicalName), row.IsSecured);
  }
  return { complete: true, columns };
}

// The declared `isSecured` of the columns the table already has, against the read. `true` on an unsecured (or unread) column secures
// it — the SDK's write is the same whatever it was. `false` on a secured column is destructive (every permission on it is deleted) and
// needs consent; on an unread one without consent nothing is written and the column is reported unknown. Omitted is never written.
function planColumnSecurity(entity, existingCols, evidence, { authorizedDestructive } = {}) {
  const operations = [];
  const unknown = [];
  const refused = [];
  const table = lower(entity && entity.schemaName);
  for (const c of (entity && entity.columns) || []) {
    if (!c || typeof c.isSecured !== 'boolean' || !existingCols.has(lower(c.schemaName))) continue;
    const column = lower(c.schemaName);
    const key = `isSecured:${table}.${column}`;
    const target = `${table}.${column}`;
    const current = evidence && evidence.complete ? evidence.columns.get(column) : undefined;
    if (current === c.isSecured) continue;
    if (c.isSecured === true) {
      operations.push({ key, kind: 'isSecured', target, action: 'update', destructive: false, publicationScopes: [], preconditions: [], table, column, isSecured: true });
      continue;
    }
    if (isAuthorized(authorizedDestructive, key)) {
      operations.push({ key, kind: 'isSecured', target, action: 'update', destructive: true, publicationScopes: [], preconditions: ['no profile holds a permission on the column'], table, column, isSecured: false });
    } else if (current === true) {
      refused.push({ key, kind: 'isSecured', target, code: 'DESTRUCTIVE_NOT_AUTHORIZED', reason: 'unsecuring a column deletes every permission any profile holds on it' });
    } else {
      unknown.push({ key, kind: 'isSecured', target, code: 'COLUMN_SECURITY_UNREAD', reason: (evidence && evidence.reason) || 'not read' });
    }
  }
  return { operations, unknown, refused };
}

async function applyColumnSecurity(plan, ctx) {
  const result = emptyFeatureResult();
  for (const r of plan.refused || []) result.refused.push(r);
  for (const u of plan.unknown || []) result.unknown.push(u);
  for (const op of plan.operations || []) {
    try {
      await ctx.sdk.updateColumn(op.table, op.column, { isSecured: op.isSecured });
    } catch (e) {
      if (e && (e.name === 'ArtifactInUseError' || e.code === 'ARTIFACT_IN_USE')) {
        result.refused.push({ key: op.key, kind: op.kind, target: op.target, code: 'FIELD_SECURITY_COLUMN_IN_USE', reason: 'a field security profile holds a permission on the column; remove it from the profile first' });
        continue;
      }
      throw e;
    }
    result.saved.push(op.key);
  }
  return result;
}

// ------------------------------------------------------------------------------------------------------------------ profiles

// The profile as the spec declares it, in the shape the SDK's artifact has: permissions sorted by table, then column (the order the
// SDK's fetch gives), each boolean false unless declared true. `description` is managed only when declared.
function desiredProfile(p) {
  const permissions = (p.permissions || []).map((x) => ({ table: lower(x.table), column: lower(x.column), read: x.read === true, create: x.create === true, update: x.update === true }))
    .sort((a, b) => (a.table === b.table ? (a.column < b.column ? -1 : a.column > b.column ? 1 : 0) : (a.table < b.table ? -1 : 1)));
  return { key: p.key, name: p.name, ...(p.description !== undefined ? { description: p.description } : {}), permissions };
}

// What differs between the declared profile and the one the environment holds, as short sentences with no values beyond names and
// booleans. Empty means the same. An existing permission the spec does not declare is a difference: the build must not keep a grant
// it did not make while reporting the profile as declared.
function profileDifferences(desired, actual) {
  const out = [];
  if (desired.description !== undefined && (desired.description || null) !== ((actual && actual.description) || null)) out.push('its description differs');
  const have = new Map(((actual && actual.permissions) || []).map((x) => [`${lower(x.table)}.${lower(x.column)}`, x]));
  for (const want of desired.permissions) {
    const id = `${want.table}.${want.column}`;
    const got = have.get(id);
    if (!got) { out.push(`it has no permission on ${id}`); continue; }
    have.delete(id);
    for (const flag of ['read', 'create', 'update']) if ((got[flag] === true) !== want[flag]) out.push(`${flag} on ${id} is ${got[flag] === true}`);
    if (got.readUnmasked && got.readUnmasked !== 'none') out.push(`it allows unmasked reads of ${id}`);
  }
  for (const id of have.keys()) out.push(`it also holds a permission on ${id}`);
  return out;
}

const isSystemAdministrator = (p) => lower(p && p.name) === lower(SYSTEM_ADMIN_PROFILE_NAME) || lower(p && p.id) === SYSTEM_ADMIN_PROFILE_ID;

// For each declared profile: find it by name, and either plan its create, find it already as declared (unchanged — the binding is
// offered as `adopted`: an exact match may be managed, never owned), or refuse it. One lookup per profile, and one read of a found one.
async function planFieldSecurity(spec, ctx) {
  const operations = [];
  const unknown = [];
  const refused = [];
  const unchanged = [];
  for (const p of (spec && spec.fieldSecurityProfiles) || []) {
    const key = `${KIND}:${p.key}`;
    const desired = desiredProfile(p);
    if (isSystemAdministrator(p)) {
      refused.push({ key, kind: KIND, target: p.key, code: 'FIELD_SECURITY_PROFILE_SYSTEM', reason: 'the System Administrator profile is managed by the platform' });
      continue;
    }
    let id;
    try {
      id = await ctx.sdk.findArtifact(KIND, { name: p.name });
    } catch (e) {
      if (e && (e.name === 'AmbiguousArtifactError' || e.code === 'AMBIGUOUS_ARTIFACT')) {
        refused.push({ key, kind: KIND, target: p.key, code: 'FIELD_SECURITY_PROFILE_AMBIGUOUS', reason: 'more than one profile has this name; rename one of them' });
        continue;
      }
      throw e;
    }
    if (!id) {
      operations.push({ key, kind: KIND, target: p.key, action: 'create', destructive: false, publicationScopes: [], preconditions: desired.permissions.map((x) => `isSecured:${x.table}.${x.column}`), desired });
      continue;
    }
    if (lower(id) === SYSTEM_ADMIN_PROFILE_ID) {
      refused.push({ key, kind: KIND, target: p.key, code: 'FIELD_SECURITY_PROFILE_SYSTEM', reason: 'the name finds the System Administrator profile' });
      continue;
    }
    const actual = await ctx.sdk.getArtifact(KIND, id);
    const differences = profileDifferences(desired, actual);
    if (differences.length) {
      refused.push({ key, kind: KIND, target: p.key, code: 'FIELD_SECURITY_PROFILE_DIFFERS', reason: `a profile with this name exists and ${differences.join('; ')} — the build does not change a profile it did not create as declared; change it in Power Apps or rename the spec's profile` });
      continue;
    }
    unchanged.push({ key, kind: KIND, target: p.key, id: lower(id) });
  }
  return { operations, unknown, refused, unchanged };
}

// Create each planned profile through the B1 create port (ctx.creates.run): the port reserves the profile's id and one id per
// permission (`childKeys`, `<table>.<column>`) before anything is sent, and refuses a create whose earlier attempt is still unknown.
// The port's answer is `{ outcome: 'created' | 'unknown', id, childIds }`; anything but `created` is reported unknown, never saved.
// A permission on a column that is not secured is refused by the platform (0x8004f508) — the build secures declared columns in the
// data-model phase first, so meeting it means the column is not declared `isSecured: true`.
async function applyFieldSecurity(plan, ctx) {
  const result = emptyFeatureResult();
  for (const r of plan.refused || []) result.refused.push(r);
  for (const u of plan.unknown || []) result.unknown.push(u);
  for (const u of plan.unchanged || []) {
    result.unchanged.push(u.key);
    result.managedBindings.push({ kind: KIND, key: u.target, id: u.id, origin: 'adopted' });
  }
  for (const op of plan.operations || []) {
    const { desired } = op;
    const childKeys = desired.permissions.map((x) => `${x.table}.${x.column}`);
    let outcome;
    try {
      outcome = await ctx.creates.run({ kind: KIND, key: desired.key, identity: { name: desired.name }, childKeys }, async ({ id, childIds }) => {
        await ctx.sdk.createArtifact(KIND, {
          id,
          name: desired.name,
          description: desired.description === undefined ? null : desired.description,
          permissions: desired.permissions.map((x) => ({ ...x, ...(childIds && childIds[`${x.table}.${x.column}`] ? { id: childIds[`${x.table}.${x.column}`] } : {}) })),
        });
        const pushed = await ctx.sdk.pushArtifact(KIND, id);
        // Lazily: entity-provision requires this module, and pushFailed is the one rule for a push that failed by value.
        if (require('./entity-provision.js').pushFailed(pushed)) {
          const err = new Error(`the profile '${desired.name}' was not saved`);
          err.code = 'FIELD_SECURITY_PROFILE_NOT_SAVED';
          throw err;
        }
        return pushed;
      });
    } catch (e) {
      const code = (e && e.code) || '';
      if (code === 'FIELD_SECURITY_COLUMN_NOT_SECURED' || serviceCodeOf(e) === COLUMN_NOT_SECURED_CODE) {
        result.refused.push({ key: op.key, kind: KIND, target: op.target, code: 'FIELD_SECURITY_COLUMN_NOT_SECURED', reason: 'a permission names a column that is not secured; declare it isSecured: true' });
        continue;
      }
      throw e;
    }
    if (outcome && outcome.outcome === 'created' && outcome.id) {
      result.saved.push(op.key);
      result.managedBindings.push({ kind: KIND, key: op.target, id: lower(outcome.id), origin: 'created' });
    } else {
      result.unknown.push({ key: op.key, kind: KIND, target: op.target, code: 'FIELD_SECURITY_PROFILE_UNKNOWN', reason: 'the create did not confirm; a later run resolves it through its reserved id' });
    }
  }
  return result;
}

function associationPath(profileId, which, principalId) {
  const a = ASSIGNEES[which];
  return `/fieldsecurityprofiles(${profileId})/${a.relationshipName}?$select=${a.key}&$filter=${a.key} eq ${principalId}`;
}

// Whether the principal already holds the profile: true / false, or null when the read does not say. One read per assignment.
async function holdsProfile(provision, profileId, which, principalId) {
  const raw = provision && provision.dataverse;
  if (!raw || typeof raw.get !== 'function') return null;
  try {
    const res = await raw.get(associationPath(profileId, which, principalId));
    if (!res || !(res.status >= 200 && res.status < 300) || !res.body || !Array.isArray(res.body.value)) return null;
    return res.body.value.some((row) => row && lower(row[ASSIGNEES[which].key]) === lower(principalId));
  } catch (_) { return null; }
}

// Give each profile to the users and teams its `assignTo` names — additive only: a holder the spec does not name is left as it is,
// and nothing is ever removed. `profileIds` maps a profile key to its id (applyFieldSecurity's managedBindings). A profile with no
// id (refused, or its create unknown) assigns nothing, and each of its assignments is reported unknown rather than skipped silently.
async function assignFieldSecurity(spec, ctx, { profileIds } = {}) {
  const result = emptyFeatureResult();
  const ids = profileIds instanceof Map ? profileIds : new Map(Object.entries(profileIds || {}));
  for (const p of (spec && spec.fieldSecurityProfiles) || []) {
    for (const which of Object.keys(ASSIGNEES)) {
      for (const principal of (p.assignTo && p.assignTo[which]) || []) {
        const principalId = lower(principal);
        const key = `${KIND}:${p.key}:${which}:${principalId}`;
        const profileId = ids.get(p.key);
        if (!profileId) {
          result.unknown.push({ key, kind: 'fieldSecurityAssignment', target: p.key, code: 'FIELD_SECURITY_PROFILE_UNRESOLVED', reason: 'the profile was not created or found as declared' });
          continue;
        }
        if (await holdsProfile(ctx.provision, profileId, which, principalId) === true) { result.unchanged.push(key); continue; }
        try {
          await ctx.sdk.associateRecords('fieldsecurityprofile', profileId, { relationshipName: ASSIGNEES[which].relationshipName, targetEntity: ASSIGNEES[which].targetEntity, targetId: principalId });
        } catch (e) {
          const status = e && (e.statusCode || e.status);
          // The association exists already (a read that could not tell, then the platform's duplicate answer): nothing to do.
          if (serviceCodeOf(e) === '0x80040237') { result.unchanged.push(key); continue; }
          if (status === 404) {
            result.refused.push({ key, kind: 'fieldSecurityAssignment', target: p.key, code: 'FIELD_SECURITY_PRINCIPAL_NOT_FOUND', reason: `no ${ASSIGNEES[which].targetEntity} has the id the spec names` });
            continue;
          }
          throw e;
        }
        result.saved.push(key);
      }
    }
  }
  return result;
}

// One check per declared profile (as declared, or not), per declared secured column (stored secured, or not) and per declared
// assignment (held, or not). Unreadable is `unknown`, never a pass. None of these is proof of what a non-administrator can see.
async function verifyFieldSecurity(spec, ctx) {
  const checks = [];
  const securityByTable = new Map();
  for (const e of (spec && spec.entities) || []) {
    for (const c of e.columns || []) {
      if (!c || typeof c.isSecured !== 'boolean') continue;
      const table = lower(e.schemaName);
      if (!securityByTable.has(table)) securityByTable.set(table, await readColumnSecurity(ctx.provision, table));
      const ev = securityByTable.get(table);
      const got = ev.complete ? ev.columns.get(lower(c.schemaName)) : undefined;
      checks.push({ key: `isSecured:${table}.${lower(c.schemaName)}`, kind: 'isSecured', target: `${table}.${lower(c.schemaName)}`, status: got === undefined ? 'unknown' : (got === c.isSecured ? 'pass' : 'fail'), detail: `declared ${c.isSecured}, deployed ${got === undefined ? 'unreadable' : got}` });
    }
  }
  for (const p of (spec && spec.fieldSecurityProfiles) || []) {
    const key = `${KIND}:${p.key}`;
    let id = null;
    let status = 'unknown';
    let detail = 'could not be read';
    try {
      id = await ctx.sdk.findArtifact(KIND, { name: p.name });
      if (!id) { status = 'fail'; detail = 'not found'; } else {
        const differences = profileDifferences(desiredProfile(p), await ctx.sdk.getArtifact(KIND, id));
        status = differences.length ? 'fail' : 'pass';
        detail = differences.length ? differences.join('; ') : 'as declared';
      }
    } catch (_) { id = null; }
    checks.push({ key, kind: KIND, target: p.key, status, detail });
    for (const which of Object.keys(ASSIGNEES)) {
      for (const principal of (p.assignTo && p.assignTo[which]) || []) {
        const held = id ? await holdsProfile(ctx.provision, id, which, lower(principal)) : null;
        checks.push({ key: `${key}:${which}:${lower(principal)}`, kind: 'fieldSecurityAssignment', target: p.key, status: held === null ? 'unknown' : (held ? 'pass' : 'fail'), detail: `${ASSIGNEES[which].targetEntity} ${held === null ? 'unreadable' : held ? 'holds the profile' : 'does not hold the profile'}` });
      }
    }
  }
  return checks;
}

module.exports = {
  ASSIGNEES,
  columnSecurityPath,
  readColumnSecurity,
  planColumnSecurity,
  applyColumnSecurity,
  desiredProfile,
  profileDifferences,
  planFieldSecurity,
  applyFieldSecurity,
  assignFieldSecurity,
  verifyFieldSecurity,
};

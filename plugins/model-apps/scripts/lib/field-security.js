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
//     ambiguous one is refused), createArtifact + pushArtifact to create it. What a found or created profile holds is read from the
//     server (readProfile), never from the workspace copy getArtifact answers.
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

// Whether every column the spec declares `isSecured: true` on is secured on the server, for a run that writes sample rows without
// running the data-model phase (which would secure them first). A column still unsecured would show the sample values to every user
// who can read the row. `tables` limits the check to the tables the run seeds (lowercased
// logical names); omitted means every table. One columnSecurityPath read per table that declares a secured column and is seeded,
// none otherwise — a spec that declares no secured column reads nothing. A column the read does not list is unknown, not secured.
async function securedBeforeSeed(spec, provision, { tables } = {}) {
  const unsecured = [];
  const unknown = [];
  for (const e of (spec && spec.entities) || []) {
    const table = lower(e && e.schemaName);
    if (!table || (tables && !tables.has(table))) continue;
    const declared = ((e && e.columns) || []).filter((c) => c && c.isSecured === true && c.type !== 'Customer' && c.schemaName).map((c) => lower(c.schemaName));
    if (!declared.length) continue;
    const read = await readColumnSecurity(provision, table);
    for (const column of declared) {
      const target = `${table}.${column}`;
      if (!read.complete) unknown.push({ target, reason: read.reason });
      else if (!read.columns.has(column)) unknown.push({ target, reason: 'the column was not found' });
      else if (read.columns.get(column) !== true) unsecured.push({ target });
    }
  }
  return { ready: !unsecured.length && !unknown.length, unsecured, unknown };
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

// The platform's values for a permission (fieldpermission): canread / cancreate / canupdate are 0 (not allowed) or 4 (allowed), and
// canreadunmasked is 0 (none), 1 (one record) or 3 (all records). Anything else — an absent or null value included — is not a value
// this module can compare, so the read is incomplete rather than coerced (the SDK's own read refuses it the same way).
// See: https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/fieldpermission
const ACCESS_BY_VALUE = new Map([[0, false], [4, true]]);
const UNMASKED_BY_VALUE = new Map([[0, 'none'], [1, 'oneRecord'], [3, 'allRecords']]);
const PERMISSION_SELECT = 'fieldpermissionid,entityname,attributelogicalname,canread,cancreate,canupdate,canreadunmasked';
const isGuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// The profile as the ENVIRONMENT holds it, read from the server and never from the SDK's local workspace: getArtifact answers the
// workspace's copy, which a fresh workspace does not have (it throws) and which, after a local create, is what this build sent —
// not what the platform holds. Two reads, the same two the SDK's own fetch makes:
//   GET /fieldsecurityprofiles(<id>)?$select=name,description
//     { "name": "HR Salary", "description": null }
//   GET /fieldpermissions?$select=fieldpermissionid,entityname,...,canreadunmasked&$filter=_fieldsecurityprofileid_value eq <id>&$orderby=fieldpermissionid
//     { "value": [ { "fieldpermissionid": "…", "entityname": "new_employee", "attributelogicalname": "new_salary",
//                    "canread": 4, "cancreate": 0, "canupdate": 4, "canreadunmasked": 0 } ],
//       "@odata.nextLink": "https://<org>/api/data/v9.2/fieldpermissions?$skiptoken=…" }   (only when there are more pages)
// The permissions are a direct collection, not an expansion of the profile: an expanded collection can be cut short with a link
// the platform does not let a client follow. A later page is followed only through the client's same-origin absolute read
// (getAbsolute); a repeated or unusable link, a failed page, a malformed row or a column named twice leaves the read incomplete,
// and an incomplete read is reported, never compared.
async function readProfile(reader, profileId) {
  const raw = reader && reader.dataverse;
  if (!raw || typeof raw.get !== 'function') return { complete: false, reason: 'no reader is available' };
  if (!isGuid(profileId)) return { complete: false, reason: 'the profile id is not a GUID' };
  const id = lower(profileId);
  const answer = async (fn) => {
    try {
      const res = await fn();
      if (!res || !(res.status >= 200 && res.status < 300) || !res.body || typeof res.body !== 'object') return { ok: false, reason: `HTTP ${res && res.status}` };
      return { ok: true, body: res.body };
    } catch (e) {
      return { ok: false, reason: `the read failed${e && e.statusCode ? ` (HTTP ${e.statusCode})` : ''}` };
    }
  };
  const head = await answer(() => raw.get(`/fieldsecurityprofiles(${id})?$select=name,description`));
  if (!head.ok) return { complete: false, reason: `the profile could not be read (${head.reason})` };
  const permissions = [];
  const seen = new Set();
  const links = new Set();
  let page = await answer(() => raw.get(`/fieldpermissions?$select=${PERMISSION_SELECT}&$filter=_fieldsecurityprofileid_value eq ${id}&$orderby=fieldpermissionid`));
  for (;;) {
    if (!page.ok) return { complete: false, reason: `its permissions could not be read (${page.reason})` };
    if (!Array.isArray(page.body.value)) return { complete: false, reason: 'its permissions are not a list' };
    for (const row of page.body.value) {
      const read = row && ACCESS_BY_VALUE.get(row.canread);
      const create = row && ACCESS_BY_VALUE.get(row.cancreate);
      const update = row && ACCESS_BY_VALUE.get(row.canupdate);
      const unmasked = row && UNMASKED_BY_VALUE.get(row.canreadunmasked);
      if (!row || typeof row.entityname !== 'string' || typeof row.attributelogicalname !== 'string'
        || read === undefined || create === undefined || update === undefined || unmasked === undefined) {
        return { complete: false, reason: 'a permission has a value this build cannot read' };
      }
      const name = `${lower(row.entityname)}.${lower(row.attributelogicalname)}`;
      if (seen.has(name)) return { complete: false, reason: `two permissions name ${name}` };
      seen.add(name);
      permissions.push({ table: lower(row.entityname), column: lower(row.attributelogicalname), read, create, update, ...(unmasked !== 'none' ? { readUnmasked: unmasked } : {}) });
    }
    const next = page.body['@odata.nextLink'];
    if (next === undefined) break;
    if (typeof next !== 'string' || !next || links.has(next) || typeof raw.getAbsolute !== 'function') return { complete: false, reason: 'its permissions continue on a page this build cannot follow' };
    links.add(next);
    page = await answer(() => raw.getAbsolute(next));
  }
  return {
    complete: true,
    profile: { id, name: typeof head.body.name === 'string' ? head.body.name : '', description: typeof head.body.description === 'string' ? head.body.description : null, permissions },
  };
}

// For each declared profile: find it by name, and either plan its create, find it already as declared (unchanged — the binding is
// offered as `adopted`: an exact match may be managed, never owned), or refuse it. One lookup per profile, and one server read of a
// found one (readProfile); a found profile that cannot be read whole is reported unknown, never compared and never adopted.
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
    const read = await readProfile(ctx.provision || ctx.sdk, id);
    if (!read.complete) {
      unknown.push({ key, kind: KIND, target: p.key, code: 'FIELD_SECURITY_PROFILE_UNREAD', reason: `a profile with this name exists but ${read.reason}` });
      continue;
    }
    const differences = profileDifferences(desired, read.profile);
    if (differences.length) {
      refused.push({ key, kind: KIND, target: p.key, code: 'FIELD_SECURITY_PROFILE_DIFFERS', reason: `a profile with this name exists and ${differences.join('; ')} — the build does not change a profile it did not create as declared; change it in Power Apps or rename the spec's profile` });
      continue;
    }
    unchanged.push({ key, kind: KIND, target: p.key, id: lower(id) });
  }
  return { operations, unknown, refused, unchanged };
}

// Create each planned profile through the create port (ctx.creates.run): the port mints the profile's id and one id per
// permission (`childKeys`, `<table>.<column>`) before anything is sent. The build's port (creates-passthrough.js) is a plain
// pass-through with no fence: it runs the create once and lets any failure through; a durable port could also refuse a create whose
// earlier attempt is still unknown, behind the same call.
// The port's answer is `{ outcome: 'created' | 'unknown', id, childIds }`; anything but `created` is reported unknown, never saved.
// `created` says the profile exists, not that it holds what was declared: the SDK's push resolves `saved` with a warning when the
// create's answer did not echo every permission exactly, and a create the port resolved from an earlier attempt ran no push here at
// all. Only a push of this run with no warning is taken as proof; otherwise the profile is read back from the server (readProfile)
// and compared — unreadable is unknown, different is refused. Either way it stays bound as `created` (the build made it and owns
// it), but it is not reported saved, and the create is never sent again.
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
    let pushed;
    try {
      outcome = await ctx.creates.run({ kind: KIND, key: desired.key, identity: { name: desired.name }, childKeys }, async ({ id, childIds }) => {
        await ctx.sdk.createArtifact(KIND, {
          id,
          name: desired.name,
          description: desired.description === undefined ? null : desired.description,
          permissions: desired.permissions.map((x) => ({ ...x, ...(childIds && childIds[`${x.table}.${x.column}`] ? { id: childIds[`${x.table}.${x.column}`] } : {}) })),
        });
        const answer = await ctx.sdk.pushArtifact(KIND, id);
        // Lazily: entity-provision requires this module, and pushFailed is the one rule for a push that failed by value.
        if (require('./entity-provision.js').pushFailed(answer)) {
          const err = new Error(`the profile '${desired.name}' was not saved`);
          err.code = 'FIELD_SECURITY_PROFILE_NOT_SAVED';
          throw err;
        }
        pushed = answer || {};
        return answer;
      });
    } catch (e) {
      const code = (e && e.code) || '';
      if (code === 'FIELD_SECURITY_COLUMN_NOT_SECURED' || serviceCodeOf(e) === COLUMN_NOT_SECURED_CODE) {
        result.refused.push({ key: op.key, kind: KIND, target: op.target, code: 'FIELD_SECURITY_COLUMN_NOT_SECURED', reason: 'a permission names a column that is not secured; declare it isSecured: true' });
        continue;
      }
      throw e;
    }
    if (!(outcome && outcome.outcome === 'created' && outcome.id)) {
      result.unknown.push({ key: op.key, kind: KIND, target: op.target, code: 'FIELD_SECURITY_PROFILE_UNKNOWN', reason: 'the create port did not confirm the create, so whether the profile exists is not proven' });
      continue;
    }
    const id = lower(outcome.id);
    result.managedBindings.push({ kind: KIND, key: op.target, id, origin: 'created' });
    const echoed = pushed !== undefined && !(Array.isArray(pushed.warnings) && pushed.warnings.length);
    if (!echoed) {
      const read = await readProfile(ctx.provision || ctx.sdk, id);
      if (!read.complete) {
        result.unknown.push({ key: op.key, kind: KIND, target: op.target, code: 'FIELD_SECURITY_PROFILE_UNREAD', reason: `the profile was created but ${read.reason}, so what it holds is not proven` });
        continue;
      }
      const differences = profileDifferences(desired, read.profile);
      if (differences.length) {
        result.refused.push({ key: op.key, kind: KIND, target: op.target, code: 'FIELD_SECURITY_PROFILE_DIFFERS', reason: `the profile was created but ${differences.join('; ')} — change it in Power Apps to match the spec` });
        continue;
      }
    }
    result.saved.push(op.key);
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
        const read = await readProfile(ctx.provision || ctx.sdk, id);
        if (!read.complete) { detail = read.reason; } else {
          const differences = profileDifferences(desiredProfile(p), read.profile);
          status = differences.length ? 'fail' : 'pass';
          detail = differences.length ? differences.join('; ') : 'as declared';
        }
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

// A teardown never deletes a field security profile: users and teams can hold one beyond this app, and a profile found by name may
// be someone else's (planFieldSecurity adopts an exact match). So each declared profile is named as kept — its name only, never its
// permissions or who holds it — the way the configuration items are (configuration-artifacts.js configurationTeardownNotes). A name
// is quoted because a profile's name is free text with spaces ("HR Confidential"). The spec gate has already refused the platform's
// System Administrator profile, so every name here is one the build may have created.
function fieldSecurityTeardownNotes(spec) {
  const profiles = spec && Array.isArray(spec.fieldSecurityProfiles) ? spec.fieldSecurityProfiles : [];
  return profiles
    .filter((p) => p && typeof p.name === 'string' && p.name.trim())
    .map((p) => `field security profile "${p.name}" kept: a teardown does not delete field security profiles, which users and teams can hold beyond this app; remove it yourself once no one needs it`);
}

module.exports = {
  ASSIGNEES,
  columnSecurityPath,
  readColumnSecurity,
  planColumnSecurity,
  applyColumnSecurity,
  securedBeforeSeed,
  desiredProfile,
  profileDifferences,
  readProfile,
  planFieldSecurity,
  applyFieldSecurity,
  assignFieldSecurity,
  verifyFieldSecurity,
  fieldSecurityTeardownNotes,
};

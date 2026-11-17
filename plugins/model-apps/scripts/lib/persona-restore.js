'use strict';
// The explicit managed download's persona proof (download-model-app.js --include-managed --managed-manifest <file>): a persona a
// restored declared process flow's `securityRoles` name, read back from the role a build made for it — written only when a
// rebuild of the downloaded spec provably leaves that role EXACTLY as it is.
//
// WHY exactness, not a best guess. `personas[]` is not a reference to a role: a build OWNS the persona's role. It reuses the
// unmanaged role carrying the SDK marker in the persona's business unit and REPLACES its privileges with the persona's compiled
// set (ReplacePrivilegesRole, vendored SDK createPersonaRole), associates or dissociates the app per `appAccess`, adds the role
// to the solution, and then ADDS the flow grants (sdk-build.js security phase, BPF_ROLE_ACCESS on the backing table). A persona
// that compiles to anything but what the role holds now would silently change who can do what on the next build. So every
// persona is proved, all or nothing, and the download refuses (and names why) on anything it cannot prove:
//   a. role: exactly one role of that name in the ROOT business unit (a written persona carries no businessUnitId, so the build
//      looks there), unmanaged (`ismanaged === false`, strictly) and carrying SDK_ROLE_MARKER. Any other row of the name there
//      would make the build refuse the persona; more than one marked row, likewise. A lookup cut short proves neither.
//   b. solution: the role is in the app's solution (solutioncomponent type 20), or a build would add it.
//   c. app: whether the role is associated with the app (appmodules(<id>)/appmoduleroles_association, every page, each row
//      naming a role; a malformed or incomplete answer refuses) is `appAccess`.
//   d. privileges: every privilege the role holds (roleprivileges, paged to the end, depth from privilegedepthmask) maps to a
//      table, and to an access a persona can declare, through the table metadata. A privilege no table carries (e.g.
//      prvExportToExcel) cannot be declared, so a build would remove it: refused.
//   e. exactness: the candidate persona, mapped through personaRoleSpecFor (which adds the appmodule read unless appAccess is
//      false) and compiled as the SDK compiles it (role-privileges.js compileRolePrivileges), must equal the held set both
//      ways: the same privileges at the same depths.
//   f. flow grants (per flow, flowGrantsMissing): the role holds create/read/write/delete at Global on the flow's backing table,
//      or a build would add them.
// The candidate holds every privilege the role holds, flow grants included, so the build's later additive grant changes nothing.
//
// Read-only: every read goes through the download's own throwaway SDK, and nothing here writes. Reads are memoised per run, so
// a persona several flows name, and the metadata several personas share, are read once.
const { odataLit } = require('./odata.js');
const { SDK_ROLE_MARKER, BPF_ROLE_ACCESS } = require('./app-spec.js');
const { depthFromMask, compileRolePrivileges, SCOPE_DEPTH, ACCESS_TYPE, DEPTH_RANK } = require('./role-privileges.js');
const { appRoleIdsComplete } = require('./app-roles.js');
const { readSolutionMembers } = require('./solution-membership.js');
const { hasMoreOf } = require('./query-completeness.js');

// sdk-build.js owns personaRoleSpecFor and the role business-unit scoping verify and teardown use; the download loads it already.
const build = () => require('./sdk-build.js');

// The one job a persona read from a role carries: the role says what it may do, not which job each privilege serves.
const JOB_NAME = 'Privileges read from the environment';
// solutioncomponent `componenttype` of a security role.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/solutioncomponent
const ROLE_COMPONENT = 20;
// Every table with the privileges it exposes, in one metadata read: what maps a held privilege id back to its table. A row:
//   { "LogicalName": "account", "Privileges": [ { "PrivilegeId": "<guid>", "Name": "prvReadAccount", "PrivilegeType": "Read", … } ] }
// Metadata is answered whole (no paging); an answer that says otherwise is not trusted.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-metadata-web-api
const TABLES_PATH = '/EntityDefinitions?$select=LogicalName,Privileges';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const bare = (v) => lc(v).replace(/[{}]/g, '');
const messageOf = (e) => String((e && e.message) || e).slice(0, 200);
const listed = (items) => (items.length > 3 ? `${items.slice(0, 3).join(', ')} and ${items.length - 3} more` : items.join(', '));
const rank = (depth) => DEPTH_RANK[lc(depth)] || 0;
// Dataverse depth name -> App Spec scope, and PrivilegeType -> App Spec access token (the SDK's spelling, `appendTo`).
const DEPTH_SCOPE = Object.fromEntries(Object.entries(SCOPE_DEPTH).map(([scope, depth]) => [depth, scope]));
const TYPE_ACCESS = Object.fromEntries(Object.entries(ACCESS_TYPE).map(([access, type]) => [type, access === 'appendto' ? 'appendTo' : access]));
const ACCESS_ORDER = ['create', 'read', 'write', 'delete', 'append', 'appendTo', 'assign', 'share'];
const SCOPE_ORDER = ['user', 'businessUnit', 'parentChild', 'organization'];

/**
 * A prover over the download's SDK for the app `appUniqueName` in solution `solutionUniqueName`:
 *   prove(name)                      -> { ok: true, name, persona, roleId, held } | { ok: false, why }
 *   flowGrantsMissing(proof, table)  -> null when the proved role holds the flow grants on `table`, else why not
 * `persona` is the spec entry to write; `held` is Map<privilegeId, depth name>. A read that fails is a refusal, never a pass.
 */
function createPersonaProver({ sdk, appUniqueName, solutionUniqueName }) {
  const memos = new Map();
  const memo = (key, fn) => {
    if (!memos.has(key)) memos.set(key, fn());
    return memos.get(key);
  };
  const query = (table, options) => sdk.queryRecords(table, options);
  const buCache = {};
  const tablePrivileges = (table) => memo(`table:${table}`, async () => {
    const rows = await sdk.getEntityPrivileges(table);
    if (!Array.isArray(rows) || !rows.length) throw new Error('no privileges were answered');
    return rows;
  });
  const privilegeTables = () => memo('tables', async () => {
    if (!sdk.dataverse || typeof sdk.dataverse.get !== 'function') throw new Error('the SDK has no metadata reader');
    const res = await sdk.dataverse.get(TABLES_PATH);
    if (!res || res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res && res.status}`);
    const body = res.body || {};
    if (!Array.isArray(body.value)) throw new Error('the answer carries no list of tables');
    if (body['@odata.nextLink']) throw new Error('the answer says more tables exist');
    const out = new Map();
    for (const t of body.value) {
      const table = lc(t && t.LogicalName);
      if (!table) continue;
      for (const p of (Array.isArray(t.Privileges) ? t.Privileges : [])) {
        const id = bare(p && p.PrivilegeId);
        if (!GUID_RE.test(id)) continue;
        if (!out.has(id)) out.set(id, []);
        out.get(id).push(table);
      }
    }
    // A privilege several tables share (the activity tables do) is declared on the first in this order; the exactness gate
    // proves the choice compiles back to the same privilege.
    for (const list of out.values()) list.sort();
    return out;
  });
  const members = () => memo('members', async () => {
    try { return await readSolutionMembers(sdk, solutionUniqueName, [ROLE_COMPONENT]); } catch { return null; }
  });
  // Strict on purpose (app-roles.js appRoleIdsComplete): an id missing from this answer is written as `appAccess: false`, which
  // a build turns into a dissociation, so only every page, each row naming a role, is an answer.
  const appRoles = () => memo('app', () => appRoleIdsComplete(sdk, appUniqueName));
  // Names for a refusal: best effort, the ids stand in when the names cannot be read.
  async function privilegeNames(ids) {
    const shown = ids.slice(0, 3);
    let names = new Map();
    try {
      const rows = await query('privilege', { select: ['privilegeid', 'name'], filter: shown.map((id) => `privilegeid eq ${id}`).join(' or ') });
      names = new Map((Array.isArray(rows) ? rows : []).map((r) => [bare(r && r.privilegeid), r && r.name]));
    } catch { /* the ids are named instead */ }
    return ids.map((id) => names.get(id) || id);
  }

  async function proveRole(name) {
    const refuse = (why) => ({ ok: false, why });
    const bu = await build().resolveRoleBusinessUnit(query, undefined, buCache);
    if (!bu) return refuse('the root business unit could not be read');
    let rows;
    try {
      rows = await query('role', { select: ['roleid', 'name', 'description', 'ismanaged'], filter: `name eq '${odataLit(name)}'${build().roleBuClause(bu)}`, top: 5 });
    } catch (e) {
      return refuse(`its role could not be read (${messageOf(e)})`);
    }
    if (!Array.isArray(rows)) return refuse('its role could not be read');
    // The lookup reads `top: 5`; a server that names a next link has more roles of that name than were read
    // (query-completeness.js hasMoreOf, judged on the SDK's own array before anything copies it), so the rows read prove
    // neither that the role is the only one nor that none of the others would make the build refuse.
    if (hasMoreOf(rows) === true) return refuse(`its role lookup was cut short, so it is not known to be the only role named '${name}' in the root business unit`);
    if (!rows.length) return refuse(`no role named '${name}' is in the root business unit`);
    if (rows.some((r) => !r || r.description !== SDK_ROLE_MARKER || r.ismanaged === true)) {
      return refuse(`a role named '${name}' in the root business unit is managed or was not made by a build, and a build refuses to change it`);
    }
    if (rows.some((r) => r.ismanaged !== false)) return refuse('whether its role is managed is not known');
    if (rows.length > 1) return refuse(`more than one role made by a build is named '${name}' in the root business unit`);
    const roleId = bare(rows[0].roleid);
    if (!GUID_RE.test(roleId)) return refuse('its role row carries no id');
    const roleName = typeof rows[0].name === 'string' && rows[0].name.trim() ? rows[0].name.trim() : name;

    const held = await members();
    if (!held) return refuse(`whether its role is in solution '${solutionUniqueName}' could not be read`);
    if (!held.members.has(`${ROLE_COMPONENT}:${roleId}`)) return refuse(`its role is not in solution '${solutionUniqueName}', so a build would add it`);
    const app = await appRoles();
    if (!app || !app.ok) return refuse(`whether the app is associated with its role could not be read (${(app && app.reason) || 'no answer'})`);
    const appAccess = app.roleIds.includes(roleId);

    // roleprivileges rows: { "privilegeid": "<guid>", "privilegedepthmask": 8 } — the mask is a bitmask (depthFromMask).
    let privRows;
    try {
      privRows = await query('roleprivileges', { select: ['privilegeid', 'privilegedepthmask'], filter: `roleid eq ${roleId}`, paginate: true });
    } catch (e) {
      return refuse(`the privileges of its role could not be read (${messageOf(e)})`);
    }
    if (!Array.isArray(privRows)) return refuse('the privileges of its role could not be read');
    const depths = new Map();
    for (const r of privRows) {
      const id = bare(r && r.privilegeid);
      const depth = depthFromMask(r && r.privilegedepthmask);
      if (!GUID_RE.test(id) || !depth) return refuse('a privilege row of its role could not be read');
      if (!depths.has(id) || rank(depth) > rank(depths.get(id))) depths.set(id, depth);
    }

    let tablesOf;
    try {
      tablesOf = await privilegeTables();
    } catch (e) {
      return refuse(`which table each privilege of its role belongs to could not be read (${messageOf(e)})`);
    }
    const unmapped = [...depths.keys()].filter((id) => !tablesOf.has(id));
    if (unmapped.length) {
      return refuse(`its role holds ${unmapped.length} privilege(s) no table carries (${listed(await privilegeNames(unmapped))}); a persona declares table privileges only, so a build would remove them`);
    }
    const nameOf = new Map();
    const readTable = async (table) => {
      try {
        const privs = await tablePrivileges(table);
        for (const p of privs) if (p && p.privilegeId) nameOf.set(bare(p.privilegeId), p.name);
        return { privs };
      } catch (e) {
        return { why: `the privileges of table '${table}' could not be read (${messageOf(e)})` };
      }
    };
    // With appAccess the build adds the appmodule read itself (personaRoleSpecFor), so the job leaves it out; at a depth other
    // than Global it is then a difference the exactness gate names.
    let appRead = null;
    if (appAccess) {
      const t = await readTable('appmodule');
      if (t.why) return refuse(t.why);
      const p = t.privs.find((x) => x && x.privilegeType === ACCESS_TYPE.read);
      appRead = p ? bare(p.privilegeId) : null;
    }
    const groups = new Map(); // "<table>|<scope>" -> { entity, scope, access: Set }
    for (const [id, depth] of depths) {
      if (id === appRead) continue;
      const table = tablesOf.get(id)[0];
      const t = await readTable(table);
      if (t.why) return refuse(t.why);
      const p = t.privs.find((x) => x && bare(x.privilegeId) === id);
      const access = p && TYPE_ACCESS[p.privilegeType];
      if (!access) return refuse(`its privilege ${(p && p.name) || id} on '${table}' is not one a persona can declare`);
      const scope = DEPTH_SCOPE[depth];
      const key = `${table}|${scope}`;
      if (!groups.has(key)) groups.set(key, { entity: table, scope, access: new Set() });
      groups.get(key).access.add(access);
    }
    const privileges = [...groups.values()]
      .sort((a, b) => (a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)))
      .map((g) => ({ entity: g.entity, access: ACCESS_ORDER.filter((a) => g.access.has(a)), scope: g.scope }));
    if (!privileges.length) return refuse('its role holds no privilege a job could declare');
    const persona = { persona: roleName, ...(appAccess ? {} : { appAccess: false }), jobs: [{ name: JOB_NAME, privileges }] };

    const roleSpec = build().personaRoleSpecFor(persona);
    // Flattened as the SDK's createPersonaRole flattens a PersonaRoleSpec before it compiles it.
    const requests = [...roleSpec.jobs.flatMap((j) => j.privileges || []), ...(roleSpec.additionalPrivileges || [])];
    const entityPrivileges = new Map();
    for (const r of requests) {
      if (entityPrivileges.has(r.entity)) continue;
      const t = await readTable(r.entity);
      if (t.why) return refuse(t.why);
      entityPrivileges.set(r.entity, t.privs);
    }
    let compiled;
    try {
      compiled = compileRolePrivileges(requests, entityPrivileges);
    } catch (e) {
      return refuse(`its privileges cannot be declared as a persona (${messageOf(e)})`);
    }
    const diffs = [];
    for (const [id, depth] of depths) {
      const c = compiled.get(id);
      const label = nameOf.get(id) || id;
      if (!c) diffs.push(`it holds ${label} at ${depth}, which a build would remove`);
      else if (c.depth !== depth) diffs.push(`it holds ${label} at ${depth}, which a build would set to ${c.depth}`);
    }
    for (const [id, c] of compiled) if (!depths.has(id)) diffs.push(`a build would add ${c.name || id} at ${c.depth}`);
    if (diffs.length) return refuse(`a persona read from its role would not rebuild it exactly (${listed(diffs)})`);
    return { ok: true, name: roleName, persona, roleId, held: depths };
  }

  async function prove(name) {
    return memo(`persona:${lc(name)}`, async () => {
      try {
        return await proveRole(String(name).trim());
      } catch (e) {
        return { ok: false, why: `its role could not be read (${messageOf(e)})` };
      }
    });
  }

  // The build grants BPF_ROLE_ACCESS at organization scope on the flow's backing table to every persona the flow names, after
  // it converges the role; a grant the role lacks now would be ADDED, so the role would change.
  async function flowGrantsMissing(proof, backing) {
    const table = lc(backing);
    if (!table) return 'the backing table of the flow is not known';
    let privs;
    try {
      privs = await tablePrivileges(table);
    } catch (e) {
      return `the privileges of the flow's backing table '${table}' could not be read (${messageOf(e)})`;
    }
    const missing = [];
    for (const access of BPF_ROLE_ACCESS) {
      const p = privs.find((x) => x && x.privilegeType === ACCESS_TYPE[access]);
      if (!p || proof.held.get(bare(p.privilegeId)) !== SCOPE_DEPTH.organization) missing.push(p ? p.name : `${access} on '${table}'`);
    }
    return missing.length ? `its role does not hold ${listed(missing)} at organization scope on the flow's backing table '${table}', which a build would grant` : null;
  }

  return { prove, flowGrantsMissing };
}

module.exports = { createPersonaProver, JOB_NAME };

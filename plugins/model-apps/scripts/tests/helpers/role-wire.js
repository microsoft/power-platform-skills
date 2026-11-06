'use strict';
// Security roles over a workflow wire (helpers/workflow-wire.js): `withRoles(wire)` replaces `wire.request` with one that
// serves the role, privilege and metadata requests the REAL vendored SDK (createPersonaRole, addEntityPrivilegesToRole,
// getEntityPrivileges) and the download's persona proof (lib/persona-restore.js) send, and hands every other request to the
// wire as before. Install it BEFORE any SDK is made over the wire: the client captures `wire.request` when it is made.
// Every request it serves is recorded in `wire.log` too, so a test that pins the writes of a run sees the role writes.
//
// What it serves, as the platform does:
//   GET  EntityDefinitions(LogicalName='<t>')?$select=LogicalName,Privileges   one table's privileges (404 for a table it lacks)
//   GET  EntityDefinitions?$select=LogicalName,Privileges                      every table's privileges
//   GET  EntityDefinitions(LogicalName='roleprivileges')?$select=EntitySetName roleprivilegescollection (the set is irregular)
//   GET  businessunits?$filter=_parentbusinessunitid_value eq null             the root business unit
//   GET  roles?$filter=name eq '<n>' and _businessunitid_value eq <bu>          the role rows
//   POST roles {name, description, businessunitid@odata.bind}                  a new unmanaged role (201 + OData-EntityId)
//   POST roles(<id>)/Microsoft.Dynamics.CRM.ReplacePrivilegesRole {Privileges} the role's privileges become exactly these
//   POST roles(<id>)/Microsoft.Dynamics.CRM.AddPrivilegesRole {Privileges}     added; a privilege held deeper keeps its depth
//   GET  roleprivilegescollection?$filter=roleid eq <id>                       {privilegeid, privilegedepthmask} rows
//   GET  privileges?$filter=privilegeid eq <id> or …                           privilege names, table or not
//   GET  solutions?$filter=uniquename eq '<n>' / solutioncomponents?…          the solution and its role members
//   GET  appmodules(<id>)/appmoduleroles_association                           the roles the app is associated with
// A request depth is the Dataverse PrivilegeDepth, by name (Basic, Local, Deep, Global) or number (0-3); a held depth is the
// roleprivileges bitmask (1 Basic, 2 Local, 4 Deep, 8 Global).
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/replaceprivilegesrole
const crypto = require('node:crypto');

const ROOT_BU = 'b0000000-0000-4000-8000-000000000001';
const CHILD_BU = 'b0000000-0000-4000-8000-000000000002';
const SOLUTION_ID = 'c0000000-0000-4000-8000-000000000001';
const MASK = { basic: 1, local: 2, deep: 4, global: 8, 0: 1, 1: 2, 2: 4, 3: 8 };
const USER_OWNED = { types: ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share'], scopes: ['Basic', 'Local', 'Deep', 'Global'] };
// An organization-owned table (a process flow's backing table, appmodule): Global only, nothing to assign or share.
const ORG_OWNED = { types: ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo'], scopes: ['Global'] };
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// A stable id per name, so a test can name a privilege without reading it back.
function idOf(name) {
  const h = crypto.createHash('sha256').update(String(name)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function withRoles(wire, { solution = 'BP', appId } = {}) {
  const tables = new Map();
  const privileges = new Map(); // id -> { id, name, table|null }
  const roles = new Map(); // id -> { roleid, name, description, ismanaged, _businessunitid_value, held: Map<privilegeId, mask> }
  const members = new Set();
  const appRoles = new Set();
  const json = (statusCode, body, headers = {}) => ({ statusCode, headers, body: body === undefined ? '' : JSON.stringify(body) });
  const lcName = (s) => String(s || '').toLowerCase();

  function table(logical, { types, scopes } = USER_OWNED) {
    const name = lcName(logical);
    const label = name.charAt(0).toUpperCase() + name.slice(1);
    const rows = types.map((type) => {
      const id = idOf(`prv${type}${label}`);
      privileges.set(id, { id, name: `prv${type}${label}`, table: name });
      return { PrivilegeId: id, Name: `prv${type}${label}`, PrivilegeType: type, CanBeBasic: scopes.includes('Basic'), CanBeLocal: scopes.includes('Local'), CanBeDeep: scopes.includes('Deep'), CanBeGlobal: scopes.includes('Global'), CanBeEntityReference: false, CanBeParentEntityReference: false };
    });
    tables.set(name, rows);
    return Object.fromEntries(rows.map((r) => [r.PrivilegeType.toLowerCase(), r.PrivilegeId]));
  }
  // A privilege no table carries (prvExportToExcel is one): a persona cannot declare it.
  function plainPrivilege(name) {
    const id = idOf(name);
    privileges.set(id, { id, name, table: null });
    return id;
  }
  function addRole({ name, bu = ROOT_BU, marked = true, managed = false, held = {} }) {
    const roleid = idOf(`role:${name}:${roles.size}`);
    const description = marked ? 'Authored by @maker-studio/cds-maker-sdk (persona/security role).' : 'Made by hand';
    roles.set(roleid, { roleid, name, description, ismanaged: managed, _businessunitid_value: bu, held: new Map(Object.entries(held)) });
    return roleid;
  }
  const heldOf = (roleId) => Object.fromEntries([...roles.get(lcName(roleId)).held].sort(([a], [b]) => (a < b ? -1 : 1)));

  // `$filter` terms the role reads send: `<field> eq <value>` joined by `and`, a value quoted ('' escapes a quote), bare (a
  // GUID, a number) or `null`, e.g.  name eq 'Dispatcher' and _businessunitid_value eq b0000000-…
  function terms(filter) {
    const out = [];
    for (const part of String(filter || '').split(/\s+and\s+/i)) {
      const m = /^\s*\(?\s*(\w+)\s+eq\s+(?:'((?:[^']|'')*)'|(\S+?))\s*\)?\s*$/i.exec(part);
      if (m) out.push([m[1].toLowerCase(), m[2] !== undefined ? m[2].replace(/''/g, "'").toLowerCase() : m[3].toLowerCase()]);
    }
    return out;
  }
  const matches = (row, filter) => terms(filter).every(([field, value]) => (value === 'null' ? row[field] == null : lcName(row[field]) === value));
  const roleRow = (r) => ({ roleid: r.roleid, name: r.name, description: r.description, ismanaged: r.ismanaged, _businessunitid_value: r._businessunitid_value });
  const tablesRow = (name) => ({ LogicalName: name, Privileges: tables.get(name) });

  function apply(method, p, q, body) {
    let m = /^EntityDefinitions\(LogicalName='([^']+)'\)$/i.exec(p);
    if (m && method === 'GET') {
      const name = lcName(m[1]);
      if (/Privileges/.test(q.get('$select') || '')) return tables.has(name) ? json(200, tablesRow(name)) : json(404, { error: { code: '0x80060888', message: `Could not find entity ${name}` } });
      if (name === 'roleprivileges') return json(200, { LogicalName: name, EntitySetName: 'roleprivilegescollection' });
      return null;
    }
    if (/^EntityDefinitions$/i.test(p) && method === 'GET' && /Privileges/.test(q.get('$select') || '')) return json(200, { value: [...tables.keys()].sort().map(tablesRow) });
    if (/^businessunits$/i.test(p) && method === 'GET') {
      const units = [{ businessunitid: ROOT_BU, _parentbusinessunitid_value: null }, { businessunitid: CHILD_BU, _parentbusinessunitid_value: ROOT_BU }];
      return json(200, { value: units.filter((u) => matches(u, q.get('$filter'))) });
    }
    if (/^roles$/i.test(p) && method === 'GET') return json(200, { value: [...roles.values()].filter((r) => matches(r, q.get('$filter'))).map(roleRow) });
    if (/^roles$/i.test(p) && method === 'POST') {
      const bu = (GUID.exec(String(body['businessunitid@odata.bind'] || '')) || [ROOT_BU])[0].toLowerCase();
      const roleid = addRole({ name: body.name, bu, marked: false });
      roles.get(roleid).description = body.description;
      return json(201, { roleid }, { 'odata-entityid': `${wire.origin || 'https://contoso.crm.dynamics.com'}/api/data/v9.2/roles(${roleid})` });
    }
    m = /^roles\(([^)]+)\)\/Microsoft\.Dynamics\.CRM\.(Replace|Add)PrivilegesRole$/i.exec(p);
    if (m && method === 'POST') {
      const r = roles.get(lcName(m[1]));
      if (!r) return json(404, { error: { code: '0x80040217', message: 'role With Id Does Not Exist' } });
      if (m[2] === 'Replace') r.held = new Map();
      for (const x of body.Privileges || []) {
        const id = lcName(x.PrivilegeId);
        const mask = MASK[lcName(x.Depth)];
        if (!mask) return json(400, { error: { code: '0x80040203', message: `bad depth ${x.Depth}` } });
        if (!r.held.has(id) || r.held.get(id) < mask) r.held.set(id, mask);
      }
      return json(204);
    }
    if (/^roleprivilegescollection$/i.test(p) && method === 'GET') {
      const t = terms(q.get('$filter')).find(([field]) => field === 'roleid');
      const r = t && roles.get(t[1]);
      return json(200, { value: r ? [...r.held].map(([privilegeid, privilegedepthmask]) => ({ privilegeid, privilegedepthmask })) : [] });
    }
    if (/^privileges$/i.test(p) && method === 'GET') {
      const ids = new Set((String(q.get('$filter') || '').match(new RegExp(GUID.source, 'gi')) || []).map(lcName));
      return json(200, { value: [...privileges.values()].filter((x) => ids.has(x.id)).map((x) => ({ privilegeid: x.id, name: x.name })) });
    }
    if (/^solutions$/i.test(p) && method === 'GET') return json(200, { value: matches({ uniquename: solution }, q.get('$filter')) ? [{ solutionid: SOLUTION_ID }] : [] });
    if (/^solutioncomponents$/i.test(p) && method === 'GET') {
      const asked = /componenttype eq 20\b/.test(q.get('$filter') || '');
      return json(200, { value: asked ? [...members].map((objectid) => ({ objectid, componenttype: 20, rootcomponentbehavior: 0 })) : [] });
    }
    m = /^appmodules\(([^)]+)\)\/appmoduleroles_association$/i.exec(p);
    if (m && method === 'GET') {
      if (appId && lcName(m[1]) !== lcName(appId)) return json(404, { error: { code: '0x80040217', message: 'appmodule With Id Does Not Exist' } });
      return json(200, { value: [...appRoles].map((roleid) => ({ roleid })) });
    }
    return null;
  }

  const inner = wire.request;
  wire.request = async (req) => {
    const url = new URL(req.url);
    const p = decodeURIComponent(url.pathname.replace(/^\/api\/data\/v[\d.]+\//, ''));
    const raw = req.body == null ? null : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const method = String(req.method).toUpperCase();
    const answer = apply(method, p, url.searchParams, body);
    if (!answer) return inner(req);
    wire.log.push({ method, url: req.url, path: p, query: url.search, body, headers: { ...(req.headers || {}) } });
    return answer;
  };

  return { table, plainPrivilege, addRole, heldOf, roles, members, appRoles, idOf, ROOT_BU, CHILD_BU };
}

module.exports = { withRoles, idOf, ROOT_BU, CHILD_BU, ORG_OWNED, USER_OWNED };

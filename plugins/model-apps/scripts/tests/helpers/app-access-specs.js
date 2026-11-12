'use strict';
// App Specs shaped like the two the access checks have to tell apart: a downloaded app extended with one new table (what a maker writes to
// add a table to an app whose security roles somebody else owns), and a spec for an app that does not exist yet.
//
// `personas[]` is left out of the extension ON PURPOSE. A persona's role is converged to exactly the privileges the spec declares (and a role
// the build did not author is refused), so naming an existing role there is the opposite of leaving it alone; an additive grant is planned
// with `roleGrants[]`.

const column = (schemaName, displayName) => ({ schemaName, displayName });

// A table the spec introduces (no `existing`).
const newTable = (schemaName, displayName) => ({
  schemaName,
  displayName,
  primaryAttribute: column(`${schemaName.split('_')[0]}_name`, 'Name'),
  columns: [],
});

// A table the app already holds: a download marks every one it recovers `existing: true`.
const existingTable = (schemaName, displayName) => ({ ...newTable(schemaName, displayName), existing: true });

const navigationTo = (...tables) => ({
  areas: [{ label: 'Work', groups: [{ label: 'Records', subAreas: tables.map((t) => ({ title: t, entity: t })) }] }],
});

// A downloaded app, one new table added. It carries what a download writes: the app's own unique name, and the table it recovered marked existing.
function extensionSpec({ newTables = ['contoso_baseline'] } = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoPm', publisherPrefix: 'contoso' },
    app: { name: 'Contoso PM', uniqueName: 'contoso_pm' },
    entities: [existingTable('contoso_project', 'Project'), ...newTables.map((t) => newTable(t, t))],
    appShell: navigationTo('contoso_project', ...newTables),
    pages: [],
    views: [],
    forms: [],
    charts: [],
  };
}

// A spec for an app that does not exist yet: nothing in it says otherwise (no unique name, no deployed ids, every table new).
function newAppSpec({ tables = ['contoso_ticket'] } = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoSupport', publisherPrefix: 'contoso' },
    app: { name: 'Contoso Support' },
    entities: tables.map((t) => newTable(t, t)),
    appShell: navigationTo(...tables),
    pages: [],
    views: [],
    forms: [],
    charts: [],
  };
}

// `roleGrants[]` entry: add privileges on `table` to the existing role `role` (a display name, or a GUID when it looks like one).
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function grant(role, table, access = ['read'], scope = 'organization') {
  return { ...(GUID.test(role) ? { roleId: role } : { role }), privileges: [{ entity: table, access, scope }] };
}

// A persona whose one job declares `privileges`.
function persona(name, privileges, extra = {}) {
  return { persona: name, jobs: [{ name: `${name} work`, privileges, surfaces: ['Records'] }], ...extra };
}

// What a read of the environment answers for an app that has these roles associated: the shape lib/app-roles.js returns. A role is a name, or
// `{ name, roleId, managed }` when a test needs two roles of one name, or a role of a chosen id.
function appWithRoles(...roles) {
  return {
    state: 'read',
    appUnique: 'contoso_pm',
    roles: roles.map((role, i) => {
      const row = typeof role === 'string' ? { name: role } : role;
      return { roleId: row.roleId || `00000000-0000-4000-8000-00000000000${i + 1}`, name: row.name, managed: row.managed === true };
    }),
  };
}

module.exports = { extensionSpec, newAppSpec, grant, persona, appWithRoles, newTable, existingTable };

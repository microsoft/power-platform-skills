'use strict';
// The navigation shapes the tests of the navigation check share (app-navigation.test.js and
// app-navigation-build.test.js). `forNew`, `forExisting` and `forUnknown` say what the check must answer for an app
// that does not exist, one that does, and one whose existence could not be read. They are written out from the
// rule (lib/app-navigation.js), never computed with the code under test.
//
//   refuse   the build stops before it writes anything
//   ok       the build goes on
//   warn     the build goes on, and says what it leaves: an app that exists, built with no navigation entries
//   unknown  fine for an app that exists, refused for a new one, and the caller could not tell which this is
//
// `kind` is what the navigation holds: `empty` (a navigation with no entry), `pages-only`, or `undeclared` (no
// `appShell.areas`, which no app of any kind is built from). `said` is what a refusal says the navigation holds;
// `pages` are the page keys the shape's entries point at.

const table = { entity: 'new_customer', title: 'Customers' };
const page = (key) => ({ page: key, title: key });
const oneGroup = (...subAreas) => ({ areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas }] }] });

// Dataverse refuses to CREATE a sitemap with no entry and accepts one on an UPDATE (measured), so an app that exists is not refused.
const NOTHING = { kind: 'empty', forNew: 'refuse', forExisting: 'warn', forUnknown: 'unknown' };
const UNDECLARED = { kind: 'undeclared', forNew: 'refuse', forExisting: 'refuse', forUnknown: 'refuse' };
const ONLY_PAGES = { kind: 'pages-only', forNew: 'refuse', forExisting: 'ok', forUnknown: 'unknown' };
const FINE = { forNew: 'ok', forExisting: 'ok', forUnknown: 'ok' };

const SHAPES = [
  { name: 'a spec with no appShell', ...UNDECLARED, appShell: undefined, said: 'the spec has no appShell.areas' },
  { name: 'an appShell with no areas array', ...UNDECLARED, appShell: {}, said: 'the spec has no appShell.areas' },
  { name: 'areas: []', ...NOTHING, appShell: { areas: [] }, said: 'appShell.areas is empty' },
  { name: 'an area with no groups key', ...NOTHING, appShell: { areas: [{ label: 'Main' }] }, said: 'no area in appShell has a group' },
  { name: 'an area with groups: []', ...NOTHING, appShell: { areas: [{ label: 'Main', groups: [] }] }, said: 'no area in appShell has a group' },
  { name: 'a group with subAreas: []', ...NOTHING, appShell: oneGroup(), said: 'no group in appShell has an entry' },
  { name: 'a group with no subAreas key', ...NOTHING, appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records' }] }] }, said: 'no group in appShell has an entry' },
  { name: 'a navigation of pages only', ...ONLY_PAGES, pages: ['overview', 'detail'], appShell: oneGroup(page('overview'), page('detail')) },
  // Once the pages are left out of a new app's first navigation, only empty groups and areas remain.
  {
    name: 'pages beside nothing but empty groups and areas',
    ...ONLY_PAGES,
    pages: ['overview'],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [page('overview')] }, { label: 'Empty', subAreas: [] }] }, { label: 'Other', groups: [] }, { label: 'Bare' }] },
  },
  { name: 'pages in two areas', ...ONLY_PAGES, pages: ['overview', 'detail'], appShell: { areas: [{ label: 'A', groups: [{ label: 'G', subAreas: [page('overview')] }] }, { label: 'B', groups: [{ label: 'G', subAreas: [page('detail')] }] }] } },
  { name: 'a table entry', ...FINE, appShell: oneGroup(table) },
  { name: 'a url entry', ...FINE, appShell: oneGroup({ url: 'https://contoso.example/help', title: 'Help' }) },
  { name: 'a table entry beside pages', ...FINE, pages: ['overview'], appShell: oneGroup(page('overview'), table) },
  { name: 'a table entry in the second area, the first holding nothing', ...FINE, appShell: { areas: [{ label: 'Empty', groups: [] }, { label: 'Main', groups: [{ label: 'Records', subAreas: [table] }] }] } },
];

// A spec the engine can run, with the shape's navigation and the pages it points at (implemented, schemaVersion 2).
function specFor(shape, extra = {}) {
  const spec = {
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', description: 'Tickets' },
    entities: [
      { schemaName: 'new_customer', displayName: 'Customer', pluralName: 'Customers', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    ],
    ...extra,
  };
  if (shape.appShell !== undefined) spec.appShell = JSON.parse(JSON.stringify(shape.appShell));
  if (shape.pages && shape.pages.length) {
    spec.schemaVersion = 2;
    spec.pages = shape.pages.map((key) => ({ key, name: key[0].toUpperCase() + key.slice(1), source: { kind: 'tsx', codeFile: `${key}.tsx` } }));
  }
  return spec;
}

module.exports = { SHAPES, specFor, table, page, oneGroup };

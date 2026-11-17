'use strict';
// A GET-only stand-in for a table's stored command bar — its MetadataId and its `appaction` rows — that the REAL
// vendored SDK reads as `fetchArtifact`/`inspectArtifact('command', '<table logical name>')`. Shared by
// tests/feature-verify.test.js (control verification) and tests/push-preview.test.js (an existing bar's preview).
const { makeTempDir } = require('./temp-dirs.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../lib/maker-sdk.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const TABLE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const APP = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_APP = 'bbbbbbbb-0000-4000-8000-00000000000b';
const id = (n) => `5a5a5a5a-0000-4000-8000-${String(n).padStart(12, '0')}`;

// One stored appaction row, as the Web API answers it (lookups as GUID strings or null, flags as booleans):
//   { appactionid, name: 'Run!<32 hex>', type: 0 button | 1 flyout | 2 split | 3 group, location: 0 form | 1 homeGrid
//     | 2 subGrid | 3 associatedGrid, buttonlabeltext, _parentappactionid_value, _appmoduleid_value, isdisabled, hidden }
function row(n, { label = `Control ${n}`, type = 0, location = 1, parent = null, app = null, disabled = false, hidden = false, sequence = n } = {}) {
  return {
    appactionid: id(n),
    name: `${label.replace(/\W/g, '')}!${id(n).replace(/-/g, '')}`,
    uniquename: '',
    type,
    location,
    context: 1,
    contextvalue: 'contoso_ticket',
    buttonlabeltext: type === 3 ? null : label,
    grouptitle: type === 3 ? '' : null,
    sequence,
    _contextentity_value: TABLE_ID,
    _parentappactionid_value: parent ? id(parent) : null,
    _appmoduleid_value: app,
    isdisabled: disabled,
    hidden,
    ismanaged: false,
    statecode: 0,
    statuscode: 1,
  };
}

// A GET-only stand-in for the environment: the table's MetadataId and its appaction rows, optionally over two pages
// with the second one failing (an incomplete read). Any other verb is recorded and refused.
function barClient(rows, { pageSize = 0, failSecondPage = false } = {}) {
  const requests = [];
  const ok = (body) => ({ status: 200, headers: {}, body });
  const client = {
    requests,
    get: async (url) => {
      const u = String(url);
      requests.push(`GET ${u.replace(ORIGIN, '')}`);
      if (/EntityDefinitions\(LogicalName='contoso_ticket'\)/.test(u)) return ok({ MetadataId: TABLE_ID });
      if (/EntityDefinitions/.test(u)) return { status: 404, headers: {}, body: { error: { code: '0x80060888', message: 'Could not find entity' } } };
      if (/\/appactions/.test(u)) {
        if (/skiptoken=2/.test(u)) {
          if (failSecondPage) return { status: 503, headers: {}, body: { error: { code: '0x80040216', message: 'unavailable' } } };
          return ok({ value: rows.slice(pageSize) });
        }
        if (pageSize && rows.length > pageSize) return ok({ value: rows.slice(0, pageSize), '@odata.nextLink': `${ORIGIN}/api/data/v9.2/appactions?$skiptoken=2` });
        return ok({ value: rows });
      }
      return ok({ value: [] });
    },
  };
  for (const m of ['post', 'patch', 'delete', 'put']) client[m] = async (url) => { requests.push(`${m.toUpperCase()} ${url}`); throw new Error('a write was attempted'); };
  return client;
}

function sdkOver(httpClient) {
  return createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('feature-verify-')), instanceUrl: ORIGIN, httpClient });
}

const BAR = [
  row(1, { label: 'Approve' }), // a top-level button on the main grid, every app
  row(2, { label: 'Run' }), // two served buttons with the same caption
  row(3, { label: 'Run' }),
  row(4, { label: 'Archive', disabled: true }), // stored disabled
  row(5, { label: 'More', type: 1 }), // flyout -> group -> button: a served menu
  row(6, { type: 3, parent: 5 }),
  row(7, { label: 'Export', parent: 6 }),
  row(8, { label: 'Tools', type: 1, disabled: true }), // a disabled flyout: its children are served nowhere
  row(9, { type: 3, parent: 8 }),
  row(10, { label: 'Recalculate', parent: 9 }),
  row(11, { label: 'Print', location: 0 }), // on the form, not the grid
  row(12, { label: 'Assign', app: OTHER_APP }), // another app's
  row(13, { label: 'Secret', hidden: true }),
  row(14, { label: 'Foreign button' }), // a row nobody declared
];

module.exports = { ORIGIN, TABLE_ID, APP, OTHER_APP, id, row, barClient, sdkOver, BAR };

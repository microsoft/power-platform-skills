'use strict';
// A fake Dataverse that answers the reads of the command-state feature in the platform's shapes, for the real raw client
// (`createAzHttpClient`, lib/sdk-http-client.js) and the real vendored SDK's API root:
//   GET /appmodules?$select=appmoduleid,uniquename&$filter=uniquename eq '<name>'
//   GET /appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appmoduleid,appmoduleidunique,componentstate&$filter=appmoduleid eq <id>
//   GET /appmodulecomponents?$select=objectid,componenttype&$filter=_appmoduleidunique_value eq <layer> and componenttype eq 1
//   GET /EntityDefinitions(LogicalName='<table>')?$select=MetadataId,EntitySetName
//   GET /EntityDefinitions(<metadataId>)?$select=LogicalName,MetadataId
//   GET /EntityDefinitions(LogicalName='appaction')?$select=IsOptimisticConcurrencyEnabled
//   GET /appactions?$select=...&$filter=contextvalue eq '<table>'      pages of `pageSize` rows, continued by an ABSOLUTE @odata.nextLink
//   GET /appactions(<id>)?$select=...                                 one row, or 404 with 0x80040217
// Every request is recorded (method, the decoded path below the API root, the absolute url, the headers); a request it has no answer for is
// recorded in `unexpected` and answered 400. `overrides(req)` may answer a request first (return a `{ statusCode, body }` or undefined).

const ORIGIN = 'https://contoso.crm.dynamics.com';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const LAYER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_APP_ID = '33333333-3333-4333-8333-333333333333';

const SELECT_ALL = [
  'appactionid', 'name', 'uniquename', 'buttonlabeltext', 'context', 'contextvalue', '_contextentity_value', '_appmoduleid_value', 'location',
  'type', 'origin', 'statecode', 'statuscode', 'ismanaged', 'iscustomizable', '_parentappactionid_value', 'hidden', 'isdisabled', 'visibilitytype',
  'visibilityformulacomponentlibrary', '_visibilityformulacomponentlibraryid_value', 'visibilityformulacomponentname', 'visibilityformulafunctionname',
  'onclickeventtype',
];

// An ordinary top-level, table-scoped, active, unmanaged JavaScript button on a table's form bar, as the platform answers it; `extra` overrides.
function commandRow(id, table, metadataId, extra = {}) {
  return {
    '@odata.etag': 'W/"1001"',
    appactionid: id,
    name: `contoso_${id.slice(0, 4)}`,
    uniquename: `contoso_${id.slice(0, 4)}`,
    buttonlabeltext: 'Escalate',
    context: 1,
    contextvalue: table,
    _contextentity_value: metadataId,
    _appmoduleid_value: null,
    location: 0,
    type: 0,
    origin: 0,
    statecode: 0,
    statuscode: 1,
    ismanaged: false,
    iscustomizable: { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: 'iscustomizableanddeletable' },
    _parentappactionid_value: null,
    hidden: false,
    isdisabled: false,
    visibilitytype: 0,
    visibilityformulacomponentlibrary: null,
    _visibilityformulacomponentlibraryid_value: null,
    visibilityformulacomponentname: null,
    visibilityformulafunctionname: null,
    onclickeventtype: 2,
    ...extra,
  };
}

const json = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const notFound = () => json(404, { error: { code: '0x80040217', message: 'appaction With Id = x Does Not Exist' } });

/**
 * @param {object} [options]
 * @param {Array<{ appmoduleid: string, uniquename: string }>} [options.apps]
 * @param {Object<string, { metadataId: string, entitySetName?: string, inApp?: boolean }>} [options.tables]
 * @param {object[]} [options.rows] - appaction rows (commandRow)
 * @param {boolean|null|'omit'} [options.concurrency] - IsOptimisticConcurrencyEnabled; 'omit' leaves it out of the answer
 * @param {number} [options.pageSize]
 * @param {(req: object) => object|undefined} [options.overrides]
 */
function createCommandStateOrg({
  apps = [{ appmoduleid: APP_ID, uniquename: 'contoso_Support' }], tables = {}, rows = [], concurrency = true, pageSize = 2, overrides,
} = {}) {
  const requests = [];
  const unexpected = [];
  const page = (all, req, base) => {
    const at = Number((/[&?]\$skiptoken=(\d+)/.exec(req.path) || [])[1] || 0);
    const value = all.slice(at, at + pageSize);
    const body = { value };
    if (at + pageSize < all.length) body['@odata.nextLink'] = `${base}&$skiptoken=${at + pageSize}`;
    return json(200, body);
  };
  async function request(opts) {
    const url = new URL(opts.url);
    const apiAt = url.pathname.search(/\/api\/data\/v9\.\d+/);
    const prefix = apiAt === -1 ? '' : /\/api\/data\/v9\.\d+/.exec(url.pathname)[0];
    const pathOnly = apiAt === -1 ? url.pathname : url.pathname.slice(apiAt + prefix.length);
    const req = { method: opts.method, url: opts.url, origin: url.origin, path: decodeURIComponent(pathOnly + url.search), headers: opts.headers || {}, body: opts.body };
    requests.push(req);
    if (overrides) {
      const answer = await overrides(req);
      if (answer) return answer;
    }
    const p = req.path;
    let m;
    if (req.method !== 'GET') { unexpected.push(req); return json(400, { error: { code: '0x0', message: 'unexpected write' } }); }
    if ((m = /^\/appmodules\?\$select=appmoduleid,uniquename&\$filter=uniquename eq '(.*)'$/.exec(p))) {
      const name = m[1].replace(/''/g, "'").toLowerCase();
      return json(200, { value: apps.filter((a) => a.uniquename.toLowerCase() === name) });
    }
    if ((m = /^\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?\$select=appmoduleid,appmoduleidunique,componentstate&\$filter=appmoduleid eq ([0-9a-f-]{36})$/.exec(p))) {
      return json(200, { value: apps.filter((a) => a.appmoduleid === m[1]).map((a) => ({ appmoduleid: a.appmoduleid, appmoduleidunique: LAYER_ID, componentstate: 0 })) });
    }
    if ((m = /^\/appmodulecomponents\?\$select=objectid,componenttype&\$filter=_appmoduleidunique_value eq ([0-9a-f-]{36}) and componenttype eq 1$/.exec(p))) {
      const value = m[1] === LAYER_ID ? Object.values(tables).filter((t) => t.inApp !== false).map((t) => ({ objectid: t.metadataId, componenttype: 1 })) : [];
      return json(200, { value });
    }
    if (p === "/EntityDefinitions(LogicalName='appaction')?$select=IsOptimisticConcurrencyEnabled") {
      return json(200, concurrency === 'omit' ? { MetadataId: 'x' } : { IsOptimisticConcurrencyEnabled: concurrency });
    }
    if ((m = /^\/EntityDefinitions\(LogicalName='([a-z0-9_]+)'\)\?\$select=MetadataId,EntitySetName$/.exec(p))) {
      const t = tables[m[1]];
      return t ? json(200, { MetadataId: t.metadataId, EntitySetName: t.entitySetName || `${m[1]}s` }) : json(404, { error: { code: '0x80060888', message: 'no such table' } });
    }
    if ((m = /^\/EntityDefinitions\(([0-9a-f-]{36})\)\?\$select=LogicalName,MetadataId$/.exec(p))) {
      const name = Object.keys(tables).find((k) => tables[k].metadataId === m[1]);
      return name ? json(200, { LogicalName: name, MetadataId: m[1] }) : json(404, { error: { code: '0x80060888', message: 'no such table' } });
    }
    if ((m = /^\/appactions\?\$select=([a-z_,]+)&\$filter=contextvalue eq '([a-z0-9_]+)'(&\$skiptoken=\d+)?$/.exec(p))) {
      const all = rows.filter((r) => typeof r.contextvalue === 'string' && r.contextvalue.toLowerCase() === m[2]);
      const base = `${url.origin}${prefix}/appactions?$select=${m[1]}&$filter=contextvalue eq '${m[2]}'`;
      return page(all, req, base);
    }
    if ((m = /^\/appactions\(([0-9a-f-]{36})\)\?\$select=[a-z_,]+$/.exec(p))) {
      const row = rows.find((r) => r.appactionid === m[1]);
      return row ? json(200, row) : notFound();
    }
    unexpected.push(req);
    return json(400, { error: { code: '0x0', message: 'unexpected request' } });
  }
  return { request, requests, unexpected, writes: () => requests.filter((r) => r.method !== 'GET') };
}

module.exports = { createCommandStateOrg, commandRow, json, notFound, ORIGIN, APP_ID, LAYER_ID, OTHER_APP_ID, SELECT_ALL };

'use strict';

// A stateful fake Dataverse for app-membership tests against the REAL vendored SDK: one app (its row, version token and
// navigation) and its current-layer component set, which changes only when an AddAppComponents or RemoveAppComponents
// is APPLIED — plain, or inside a `$batch` change set. A change set is applied as a whole only when its first PATCH's
// If-Match is the row's version (Dataverse rolls the set back on 412), the way the SDK's guarded pin relies on.
// `lose` scripts what happens to each change set, in order:
//   'beforeCommit'  the answer is lost and nothing was applied
//   'afterCommit'   the set was applied, then the answer was lost
//   'held'          the set is kept unapplied (a late original); `landLateOriginal()` applies it later, guard and all
//   undefined       applied and answered normally
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../vendor/cds-maker-sdk.cjs');
const { APP, PUBLISHED, FORM_A, FORM_B, META } = require('./app-membership-sdk.js');

const SITEMAP = '55555555-0000-4000-8000-000000000001';
const VIEW = '66666666-0000-4000-8000-000000000001';
const CHART = '77777777-0000-4000-8000-000000000001';
// A chart of a table the navigation does not name: the SDK derives no membership for it.
const OFFNAV_CHART = '77777777-0000-4000-8000-000000000002';
// A Quick Create form of the navigation's table, and two Main forms of a table the navigation does not name.
const FORM_QUICK = '33333333-0000-4000-8000-000000000011';
const OFFNAV_FORM_A = '33333333-0000-4000-8000-000000000021';
const OFFNAV_FORM_B = '33333333-0000-4000-8000-000000000022';
// systemform type: 2 Main, 7 Quick Create. https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/systemform
const FORMS = [
  { formid: FORM_A, name: 'Summary', type: 2, objecttypecode: 'contoso_item' },
  { formid: FORM_B, name: 'Alternate', type: 2, objecttypecode: 'contoso_item' },
  { formid: FORM_QUICK, name: 'Quick', type: 7, objecttypecode: 'contoso_item' },
  { formid: OFFNAV_FORM_A, name: 'Other summary', type: 2, objecttypecode: 'contoso_other' },
  { formid: OFFNAV_FORM_B, name: 'Other detail', type: 2, objecttypecode: 'contoso_other' },
];
const navigation = (title) => '<SiteMap><Area Id="A"><Titles><Title LCID="1033" Title="Main"/></Titles><Group Id="G">'
  + '<Titles><Title LCID="1033" Title="Records"/></Titles><SubArea Id="Items" Entity="contoso_item">'
  + `<Titles><Title LCID="1033" Title="${title}"/></Titles></SubArea></Group></Area></SiteMap>`;

// The members one AddAppComponents/RemoveAppComponents body names, as `type:objectid`:
//   { "AppId": "<app>", "Components": [ { "@odata.id": "contoso_items(<MetadataId>)" },
//     { "@odata.type": "Microsoft.Dynamics.CRM.systemform", "formid": "<id>" }, … ] }
const TYPED = { 'Microsoft.Dynamics.CRM.systemform': ['formid', 60], 'Microsoft.Dynamics.CRM.savedquery': ['savedqueryid', 26], 'Microsoft.Dynamics.CRM.savedqueryvisualization': ['savedqueryvisualizationid', 59] };
function memberKeys(body) {
  return ((body && body.Components) || []).map((component) => {
    if (component['@odata.id']) return `1:${/\(([^)]+)\)/.exec(component['@odata.id'])[1].toLowerCase()}`;
    const [field, type] = TYPED[component['@odata.type']];
    return `${type}:${component[field].toLowerCase()}`;
  });
}

// The parts of the change set the SDK sends (helpers/batch-bodies.js shows the request shape), each as
// { method, url, etag, body }.
function changeSetParts(text) {
  return String(text).split(/^--changeset_[^\r\n]*$/m).slice(1).map((part) => {
    const request = /^(GET|POST|PATCH|DELETE) (\S+) HTTP\/1\.1$/m.exec(part);
    if (!request) return null;
    const etag = /^If-Match: (.+)$/m.exec(part);
    const json = /^(\{.*\})\s*$/m.exec(part);
    return { method: request[1], url: request[2], etag: etag && etag[1].trim(), body: json ? JSON.parse(json[1]) : undefined };
  }).filter(Boolean);
}

// `rows` replaces the enumeration answer of one collection, by its entity set name ('systemforms', 'savedqueries',
// 'savedqueryvisualizations'), to model an answer the reader must not trust (a row with no id, a non-GUID id); a test may
// also set `state.rows` after the first push, so only the later reads see it.
function appPinServer(t, { lose = [], members, rows: answerRows = {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-server-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = {
    version: 1, name: 'Membership', sitemapXml: navigation('Items'),
    members: new Set(members || [`1:${META.contoso_item}`, `62:${SITEMAP}`]),
    lose: [...lose], late: null, requests: [], rows: { ...answerRows },
  };
  const token = () => `W/"${state.version}"`;
  const appRow = () => ({ appmoduleid: APP, appmoduleidunique: PUBLISHED, componentstate: 0, ismanaged: false, name: state.name, uniquename: 'contoso_membership', description: '', '@odata.etag': token() });
  const sitemapRow = () => ({ sitemapid: SITEMAP, sitemapxml: state.sitemapXml, sitemapname: 'Membership', sitemapnameunique: 'contoso_membership', '@odata.etag': 'W/"1"' });
  const applyOne = ({ method, url, body }) => {
    if (method === 'POST' && url.endsWith('/AddAppComponents')) memberKeys(body).forEach((key) => state.members.add(key));
    else if (method === 'POST' && url.endsWith('/RemoveAppComponents')) memberKeys(body).forEach((key) => state.members.delete(key));
    else if (method === 'PATCH' && url.includes('/sitemaps(') && body && body.sitemapxml !== undefined) state.sitemapXml = body.sitemapxml;
    else if (method === 'PATCH' && url.includes('/appmodules(')) {
      if (body && body.name !== undefined) state.name = body.name;
      state.version += 1;
    }
  };
  const applySet = (parts) => {
    if (parts[0].etag && parts[0].etag !== token()) return false;
    parts.forEach(applyOne);
    return true;
  };
  const lost = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const httpClient = {
    get: async (url) => {
      state.requests.push(`GET ${url}`);
      const parsed = new URL(url);
      const filter = parsed.searchParams.get('$filter') || '';
      let body = { value: [] };
      let headers = { ETag: 'W/"1"' };
      if (url.includes('EntityDefinitions')) body = { MetadataId: META.contoso_item, EntitySetName: 'contoso_items', LogicalName: 'contoso_item' };
      else if (parsed.pathname.endsWith(`appmodules(${APP})`)) { body = appRow(); headers = { ETag: token() }; }
      else if (url.includes('/appmodules')) body = { value: [appRow()] };
      else if (url.includes('/appmodulecomponents')) {
        const type = /componenttype eq (\d+)/.exec(filter);
        body = { value: [...state.members].map((key) => key.split(':')).filter(([kind]) => !type || kind === type[1])
          .map(([kind, objectid]) => ({ objectid, componenttype: Number(kind) })) };
      } else if (url.includes('/sitemaps')) body = parsed.pathname.includes('/sitemaps(') ? sitemapRow() : { value: [sitemapRow()] };
      else if (url.includes('/systemforms')) {
        // The reader's filter is applied the way Dataverse applies it: a classification read (`formid eq <id> or …`)
        // answers only the forms it names, an enumeration (`objecttypecode eq '<t>' and type eq 2 …`) only that
        // table's forms of that type.
        const named = [...filter.matchAll(/formid eq \{?([0-9a-f-]{36})\}?/gi)].map((match) => match[1].toLowerCase());
        const table = /objecttypecode eq '([^']+)'/.exec(filter);
        const type = /\btype eq (\d+)/.exec(filter);
        body = { value: state.rows.systemforms || FORMS.filter((form) => (!named.length || named.includes(form.formid))
          && (!table || form.objecttypecode === table[1]) && (!type || form.type === Number(type[1])))
          .map((form) => ({ formactivationstate: 1, ...form })) };
      } else if (url.includes('/savedqueryvisualizations')) {
        body = { value: state.rows.savedqueryvisualizations || (url.includes(OFFNAV_CHART) ? [{ savedqueryvisualizationid: OFFNAV_CHART, primaryentitytypecode: 'contoso_other' }] : [{ savedqueryvisualizationid: CHART }]) };
      } else if (url.includes('/savedqueries')) body = { value: state.rows.savedqueries || [{ savedqueryid: VIEW }] };
      return { status: 200, headers, body };
    },
    post: async (url, body) => {
      state.requests.push(`POST ${url} ${JSON.stringify(body)}`);
      applyOne({ method: 'POST', url, body });
      return { status: 204, headers: {}, body: null };
    },
    patch: async (url, body) => {
      state.requests.push(`PATCH ${url} ${JSON.stringify(body)}`);
      applyOne({ method: 'PATCH', url, body });
      return { status: 200, headers: { ETag: url.includes('/appmodules(') ? token() : 'W/"9"' }, body: { '@odata.etag': url.includes('/appmodules(') ? token() : 'W/"9"' } };
    },
    delete: async () => ({ status: 204, headers: {}, body: null }),
    put: async () => ({ status: 204, headers: {}, body: null }),
    postRaw: async (url, text) => {
      const parts = changeSetParts(text);
      state.requests.push(`BATCH ${parts.map((part) => `${part.method} ${part.url.replace(/^.*\/v9\.\d\//, '/')}${part.body ? ` ${JSON.stringify(part.body)}` : ''}`).join(' | ')}`);
      const mode = state.lose.shift();
      if (mode === 'afterCommit') { applySet(parts); throw lost(); }
      if (mode === 'beforeCommit') throw lost();
      if (mode === 'held') { state.late = parts; throw lost(); }
      const committed = applySet(parts);
      // Committed: one answer per part, the last PATCH (the echo) returning the row's new version; refused: the guard alone, 412.
      const lines = ['--batchresponse_x', 'Content-Type: multipart/mixed; boundary=changesetresponse_x', ''];
      const answers = committed ? parts.map((part, index) => (index === parts.length - 1 && part.method === 'PATCH' ? 200 : 204)) : [412];
      answers.forEach((status, index) => lines.push('--changesetresponse_x', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary',
        `Content-ID: ${index + 1}`, '', `HTTP/1.1 ${status} ${status === 200 ? 'OK' : status === 204 ? 'No Content' : 'Precondition Failed'}`,
        ...(status === 200 ? [`ETag: ${token()}`, 'Content-Type: application/json', '', JSON.stringify({ appmoduleid: APP, '@odata.etag': token() })] : ['']), ''));
      lines.push('--changesetresponse_x--', '--batchresponse_x--', '');
      return { status: 200, headers: {}, body: lines.join('\r\n') };
    },
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(directory), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  return { sdk, state, httpClient, landLateOriginal: () => { const parts = state.late; state.late = null; return parts ? applySet(parts) : null; } };
}

module.exports = { appPinServer, navigation, SITEMAP, VIEW, CHART, OFFNAV_CHART, FORM_QUICK, OFFNAV_FORM_A, OFFNAV_FORM_B };

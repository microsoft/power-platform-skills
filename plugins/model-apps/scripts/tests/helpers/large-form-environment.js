'use strict';
// The system forms of a LARGE environment, as the page-reference guard (lib/page-reference-guard.js) reads them, over the low-level transport the plugin's
// az-token HttpClient takes (`request({ url, method, headers, timeout })` -> `{ statusCode, headers, body }`):
//   GET /systemforms?$select=formid,objecttypecode,name,type,formxml                                                     the published layer
//   GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode,name,type,formxml  the saved layer
//
// What it models is what was measured on an environment of 3700 forms (every answer 200, no throttling):
//   - an answer costs time per form it holds: about 21.6 ms in the saved layer (one unpaged answer of 3700 forms took 80.1 s) and 3.2 ms in the published one
//     (11.8 s). An answer that would take longer than the request's `timeout` (the client's 60 s read timeout) is cut off the way the live run recorded it:
//     `{ error: 'read ECONNRESET', code: 'ECONNRESET' }`, which the client sends again on its retry schedule;
//   - with no `Prefer: odata.maxpagesize` an answer holds up to 5000 rows (the platform's default page); with it, at most that many, the header
//     `Preference-Applied: odata.maxpagesize=<n>` and an ABSOLUTE `@odata.nextLink` while forms remain:
//       { "value": [ … ], "@odata.nextLink": "https://contoso.crm.dynamics.com/api/data/v9.0/systemforms?$select=…&$skiptoken=100" }
//     A continuation read is held to the same rule: the paging rule asks for the same preference on every page
//     (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/page-results), and one sent without it is answered as a first read is.
//
//   const env = largeFormEnvironment({ forms, origin });
//   const client = createAzHttpClient(origin, { getToken, request: env.wrap(org.request), sleep: async () => {} });
// `forms` are rows { formid, objecttypecode, name, type, formxml, layer? } (a row with no `layer` is in both). `env.log` records each form read:
// { layer, prefer, rows, ms, outcome: 200 | 'ECONNRESET' }, the `ms` being what the measured costs make of it.
const API_ROOT = /^\/api\/data\/v9\.\d/;
const FORM_SCAN = /^\/systemforms(\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\))?\?\$select=formid,objecttypecode,name,type,formxml(?:&\$skiptoken=(\d+))?$/;
const MS_PER_FORM = Object.freeze({ saved: 80103 / 3700, published: 11768 / 3700 });
const PLATFORM_PAGE = 5000;

// `count` plain forms of `account` with distinct ids, in both layers.
function plainForms(count, formxml = '<form><tabs><tab name="general"/></tabs></form>') {
  return Array.from({ length: count }, (_, i) => ({ formid: `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, objecttypecode: 'account', name: `Form ${i}`, type: 2, formxml }));
}

function largeFormEnvironment({ forms, origin = 'https://contoso.crm.dynamics.com', msPerForm = MS_PER_FORM } = {}) {
  const log = [];
  function answer({ url, method, headers, timeout }) {
    if (method !== 'GET') return null;
    const parsed = new URL(url);
    const where = decodeURIComponent(parsed.pathname + parsed.search).replace(API_ROOT, '');
    const m = FORM_SCAN.exec(where);
    if (!m) return null;
    const layer = m[1] ? 'saved' : 'published';
    const preferHeader = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'prefer');
    const asked = preferHeader ? Number((/odata\.maxpagesize=(\d+)/.exec(preferHeader[1]) || [])[1]) : NaN;
    const size = asked > 0 && asked <= PLATFORM_PAGE ? asked : PLATFORM_PAGE;
    const at = Number(m[2] || 0);
    const all = forms.filter((f) => !f.layer || f.layer === layer).map(({ layer: _, ...row }) => row);
    const value = all.slice(at, at + size);
    const ms = Math.round(value.length * msPerForm[layer]);
    const entry = { layer, prefer: preferHeader ? preferHeader[1] : null, rows: value.length, ms };
    log.push(entry);
    if (timeout && ms > timeout) {
      entry.outcome = 'ECONNRESET';
      entry.ms = timeout;
      return { error: 'read ECONNRESET', code: 'ECONNRESET' };
    }
    entry.outcome = 200;
    const base = `${origin}/api/data/v9.0${where.replace(/&\$skiptoken=\d+$/, '')}`;
    const body = { value, ...(at + size < all.length ? { '@odata.nextLink': `${base}&$skiptoken=${at + size}` } : {}) };
    return { statusCode: 200, headers: { 'content-type': 'application/json', ...(size === asked ? { 'preference-applied': `odata.maxpagesize=${size}` } : {}) }, body: JSON.stringify(body) };
  }
  return {
    log,
    // The transport of a fake org with the forms answered here first; every other request goes on to `request`.
    wrap: (request) => async (args) => answer(args) || request(args),
    // What the reads cost, as measured: the most one read took and all of them together.
    cost: () => ({ reads: log.length, slowestMs: Math.max(0, ...log.map((e) => e.ms)), totalMs: log.reduce((sum, e) => sum + e.ms, 0) }),
  };
}

module.exports = { largeFormEnvironment, plainForms, MS_PER_FORM };

'use strict';

// A stateful fake of what the SDK's app theme (setAppTheme / getAppTheme) reads and writes, for tests against the REAL
// vendored SDK. It is layered on appPinServer: it answers the requests it models and hands every other request (the
// app row, its components, the app's guarded publish `$batch`) to the pin server, so ONE SDK instance can both hold an
// app's exact Main-form obligation and set its theme — the way the build's single SDK does.
//
// What it models (the platform behaviour the SDK relies on):
//   appsetting row   a POST creates a draft; a PATCH sets the draft (a published row needs its own ETag, a draft only
//                    `*`); a DELETE removes a draft-only row, but leaves a published row in place, removal pending, until
//                    the app is published.
//   reads            a plain `GET /appsettings` answers the published layer only; through RetrieveUnpublishedMultiple
//                    it answers the draft (componentstate 1), else the published value (0), and skips a pending removal.
//   RetrieveSetting  answers what the app resolved at its LAST APP PUBLISH, else the environment's value, else the
//                    sentinel `""` ("no theme"), e.g.
//                      GET /RetrieveSetting(SettingName='CustomThemeDefinition',AppUniqueName='contoso_membership')
//                      { "SettingDetail": { "Name": "CustomThemeDefinition", "Value": "\"\"", "DataType": 1 } }
//   PublishXml       `<webresource>{id}</webresource>` publishes that resource's content; `<appmodule>{id}</appmodule>`
//                    (also inside the app's `$batch`) promotes the app's drafts, drops its pending removals and
//                    re-resolves what it shows.
//   web resources    a POST needs a name carrying a known publisher prefix and not yet taken.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/appsetting
// https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/modern-theme-overrides

const { randomUUID } = require('node:crypto');
const { appPinServer } = require('./app-pin-server.js');
const { APP } = require('./app-membership-sdk.js');

const THEME_DEF = '11111111-0000-4000-8000-00000000aaaa';
const HEADER_DEF = '11111111-0000-4000-8000-00000000bbbb';
// The appsetting solution component type is per-environment; the SDK reads it (solutioncomponentdefinitions).
const APPSETTING_TYPE = 12345;
const SENTINEL = '""';
const SOLUTION = 'ContosoMembership';
const APP_UNIQUE = 'contoso_membership';

const reply = (status, body, headers = {}) => ({ status, headers, body });
const odataError = (status, code, message) => reply(status, { error: { code, message } });
const captures = (re, text) => [...String(text).matchAll(re)].map((match) => match[1].toLowerCase());
const header = (options, name) => {
  const headers = (options && options.headers) || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
};

// options:
//   environmentTheme  the name of an XML web resource the ENVIRONMENT's theme setting names (seeded, published)
//   row               seed the app's theme row: { published?, draft?, removalPending? } (values are setting values)
//   pin               options for the underlying appPinServer (lose, members, rows)
function appThemeServer(t, { environmentTheme, row, pin = {} } = {}) {
  const theme = {
    rows: [], webResources: [], resolved: new Map(), environment: new Map([[THEME_DEF, SENTINEL], [HEADER_DEF, SENTINEL]]),
    publishers: new Set(['contoso']), members: new Set(), solutionId: randomUUID(), requests: [], fail: [],
  };
  const addWebResource = (name, type, text, published = true) => {
    const content = Buffer.from(text, 'utf8').toString('base64');
    const resource = { id: randomUUID(), name, type, content, publishedContent: published ? content : undefined, version: 1 };
    theme.webResources.push(resource);
    return resource;
  };
  if (environmentTheme) {
    addWebResource(environmentTheme, 4, '<CustomTheme><BasePaletteColor>#5C2D91</BasePaletteColor></CustomTheme>');
    theme.environment.set(THEME_DEF, environmentTheme);
  }
  if (row) {
    theme.rows.push({ id: randomUUID(), app: APP, def: THEME_DEF, published: row.published !== undefined ? row.published : null,
      draft: row.draft !== undefined ? row.draft : null, removalPending: Boolean(row.removalPending), version: 100 });
    if (row.published !== undefined) theme.resolved.set(THEME_DEF, row.published);
  }
  const resolvedFor = (def) => (theme.resolved.has(def) ? theme.resolved.get(def) : theme.environment.get(def) || SENTINEL);
  const rowOf = (id) => theme.rows.find((candidate) => candidate.id === id);
  const join = (options, member) => { if (header(options, 'MSCRM.SolutionUniqueName') === SOLUTION) theme.members.add(member); };

  const publishApps = (text) => {
    for (const appId of captures(/<appmodule>\{?([0-9a-f-]{36})\}?<\/appmodule>/gi, text)) {
      for (const candidate of [...theme.rows].filter((r) => r.app === appId)) {
        if (candidate.removalPending) theme.rows.splice(theme.rows.indexOf(candidate), 1);
        else if (candidate.draft !== null) { candidate.published = candidate.draft; candidate.draft = null; candidate.version += 1; }
      }
      for (const def of [THEME_DEF, HEADER_DEF]) {
        const current = theme.rows.find((r) => r.app === appId && r.def === def);
        if (current && current.published !== null) theme.resolved.set(def, current.published);
        else theme.resolved.delete(def);
      }
    }
  };
  const publish = (xml) => {
    for (const id of captures(/<webresource>\{?([0-9a-f-]{36})\}?<\/webresource>/gi, xml)) {
      const resource = theme.webResources.find((candidate) => candidate.id === id);
      if (resource) { resource.publishedContent = resource.content; resource.version += 1; }
    }
    publishApps(xml);
  };

  const readRows = (route) => {
    const unpublished = route.includes('RetrieveUnpublishedMultiple');
    const app = /_parentappmoduleid_value eq ([0-9a-f-]{36})/i.exec(route);
    const defs = captures(/_settingdefinitionid_value eq ([0-9a-f-]{36})/gi, route);
    const value = [];
    for (const candidate of theme.rows) {
      if ((app && candidate.app !== app[1].toLowerCase()) || (defs.length && !defs.includes(candidate.def))) continue;
      const base = { appsettingid: candidate.id, _settingdefinitionid_value: candidate.def, _parentappmoduleid_value: candidate.app };
      if (unpublished && candidate.removalPending) continue;
      if (unpublished && candidate.draft !== null) value.push({ ...base, '@odata.etag': `W/"${candidate.version + 1}"`, value: candidate.draft, componentstate: 1 });
      else if (candidate.published !== null) value.push({ ...base, '@odata.etag': `W/"${candidate.version}"`, value: candidate.published, componentstate: 0 });
    }
    return reply(200, { value });
  };

  // A scripted failure, consumed once, for the first request whose `METHOD route` starts with `match`:
  //   'beforeCommit' the answer is lost and nothing was applied; 'afterCommit' applied, then the answer was lost;
  //   a number, answered as that HTTP status with nothing applied.
  const failure = (method, route) => {
    const index = theme.fail.findIndex((entry) => `${method} ${route}`.startsWith(entry.match));
    return index < 0 ? undefined : theme.fail.splice(index, 1)[0].mode;
  };
  const lost = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

  const route = (method, route, body, options) => {
    if (method === 'GET' && route.startsWith('/settingdefinitions')) {
      return reply(200, { value: [
        ...(route.includes("'CustomThemeDefinition'") ? [{ settingdefinitionid: THEME_DEF, uniquename: 'CustomThemeDefinition', displayname: 'Custom theme definition' }] : []),
        ...(route.includes("'OverrideAppHeaderColor'") ? [{ settingdefinitionid: HEADER_DEF, uniquename: 'OverrideAppHeaderColor', displayname: 'Override app header colors' }] : []),
      ] });
    }
    if (method === 'GET' && route.startsWith('/appsettings')) return readRows(route);
    if (method === 'POST' && route === '/appsettings') {
      const app = (/appmodules\(([0-9a-f-]{36})\)/i.exec(String(body['parentappmoduleid@odata.bind'])) || [])[1];
      const def = (/settingdefinitions\(([0-9a-f-]{36})\)/i.exec(String(body['settingdefinitionid@odata.bind'])) || [])[1];
      if (theme.rows.some((r) => r.app === app && r.def === def)) return odataError(400, '0x80072013', 'Cannot complete the creation of AppSetting because it violates a database constraint.');
      const created = { id: randomUUID(), app: app.toLowerCase(), def: def.toLowerCase(), published: null, draft: String(body.value), removalPending: false, version: 500 };
      theme.rows.push(created);
      join(options, `${APPSETTING_TYPE}:${created.id}`);
      return reply(204, undefined, { 'OData-EntityId': `https://contoso.crm.dynamics.com/api/data/v9.2/appsettings(${created.id})` });
    }
    const rowMatch = /^\/appsettings\(([0-9a-f-]{36})\)$/i.exec(route);
    if (rowMatch && (method === 'PATCH' || method === 'DELETE')) {
      const target = rowOf(rowMatch[1].toLowerCase());
      if (!target) return odataError(404, '0x80040217', 'Does Not Exist');
      const ifMatch = header(options, 'If-Match');
      if (target.published === null && ifMatch && ifMatch !== '*') return odataError(400, '0x80040216', 'The retrieval of version numbers failed to return all records.');
      if (target.published !== null && ifMatch && ifMatch !== '*' && ifMatch !== `W/"${target.version}"`) return odataError(412, '0x80060882', 'The version of the existing record does not match the RowVersion property provided.');
      if (method === 'PATCH') {
        target.draft = String(body.value);
        target.removalPending = false;
        target.version += 1;
      } else if (target.published === null) {
        theme.rows.splice(theme.rows.indexOf(target), 1);
      } else {
        target.draft = null;
        target.removalPending = true;
      }
      return reply(204);
    }
    if (method === 'GET' && route.startsWith('/RetrieveSetting(')) {
      const name = (/SettingName='([^']+)'/.exec(route) || [])[1];
      const def = name === 'CustomThemeDefinition' ? THEME_DEF : name === 'OverrideAppHeaderColor' ? HEADER_DEF : '';
      if (!def) return odataError(404, '0x80040217', 'no such setting');
      const forApp = /AppUniqueName='([^']+)'/.exec(route);
      const value = forApp && forApp[1] === APP_UNIQUE ? resolvedFor(def) : theme.environment.get(def) || SENTINEL;
      return reply(200, { SettingDetail: { Name: name, Value: value, DataType: 1 } });
    }
    if (method === 'GET' && route.startsWith('/publishers')) {
      const prefix = (/customizationprefix eq '([^']+)'/.exec(route) || [])[1];
      return reply(200, { value: prefix && theme.publishers.has(prefix) ? [{ publisherid: randomUUID() }] : [] });
    }
    if (method === 'GET' && route.startsWith('/solutions')) {
      const unique = (/uniquename eq '([^']+)'/.exec(route) || [])[1];
      return reply(200, { value: unique === SOLUTION ? [{ solutionid: theme.solutionId, uniquename: SOLUTION, friendlyname: SOLUTION, version: '1.0.0.0', ismanaged: false,
        publisherid: { publisherid: randomUUID(), uniquename: 'contoso', customizationprefix: 'contoso', customizationoptionvalueprefix: 10000 } }] : [] });
    }
    if (method === 'GET' && route.startsWith('/solutioncomponentdefinitions')) return reply(200, { value: [{ solutioncomponenttype: APPSETTING_TYPE, primaryentityname: 'appsetting' }] });
    if (method === 'GET' && route.startsWith('/solutioncomponents')) {
      const ids = captures(/objectid eq ([0-9a-f-]{36})/gi, route);
      return reply(200, { value: [...theme.members].map((member) => member.split(':'))
        .map(([type, objectid]) => ({ componenttype: Number(type), objectid })).filter((member) => !ids.length || ids.includes(member.objectid)) });
    }
    if (method === 'POST' && route === '/AddSolutionComponent') {
      if (body.SolutionUniqueName !== SOLUTION) return odataError(404, '0x80040217', 'The given solution unique name is not valid');
      theme.members.add(`${Number(body.ComponentType)}:${String(body.ComponentId).toLowerCase()}`);
      const settingRow = Number(body.ComponentType) === APPSETTING_TYPE && rowOf(String(body.ComponentId).toLowerCase());
      if (settingRow) theme.members.add(`80:${settingRow.app}`);
      return reply(200, {});
    }
    if (method === 'GET' && route.startsWith('/webresourceset?')) {
      const name = ((/name eq '((?:[^']|'')+)'/.exec(route) || [])[1] || '').replace(/''/g, "'");
      const found = theme.webResources.find((resource) => resource.name.toLowerCase() === name.toLowerCase());
      return reply(200, { value: found ? [{ '@odata.etag': `W/"${found.version}"`, webresourceid: found.id, name: found.name, webresourcetype: found.type,
        content: found.publishedContent !== undefined ? found.publishedContent : found.content }] : [] });
    }
    const resourceMatch = /^\/webresourceset\(([0-9a-f-]{36})\)/i.exec(route);
    if (resourceMatch && method === 'GET') {
      const found = theme.webResources.find((resource) => resource.id === resourceMatch[1].toLowerCase());
      return found ? reply(200, { '@odata.etag': `W/"${found.version}"`, name: found.name, content: found.publishedContent !== undefined ? found.publishedContent : found.content })
        : odataError(404, '0x80040217', 'Does Not Exist');
    }
    if (method === 'POST' && route === '/webresourceset') {
      const name = String(body.name || '');
      const prefix = (/^([^_/]+)_/.exec(name) || [])[1];
      if (!prefix || !theme.publishers.has(prefix)) return odataError(400, '0x8004f118', 'Webresource name does not contain a valid prefix.');
      if (theme.webResources.some((resource) => resource.name.toLowerCase() === name.toLowerCase())) return odataError(400, '0x8004f115', 'A webresource with the same name already exists.');
      const resource = { id: randomUUID(), name, type: Number(body.webresourcetype), content: String(body.content || ''), version: 1 };
      theme.webResources.push(resource);
      join(options, `61:${resource.id}`);
      return reply(204, undefined, { 'OData-EntityId': `https://contoso.crm.dynamics.com/api/data/v9.2/webresourceset(${resource.id})` });
    }
    return undefined;
  };

  const relative = (url) => decodeURIComponent(String(url).replace(/^https?:\/\/[^/]+\/api\/data\/v9\.\d+/, ''));
  const wrap = (base) => {
    const handle = async (method, url, body, options, delegate) => {
      const path = relative(url);
      theme.requests.push(`${method} ${path}${body !== undefined ? ` ${JSON.stringify(body)}` : ''}`);
      const mode = failure(method, path);
      if (mode === 'beforeCommit') throw lost();
      if (typeof mode === 'number') return odataError(mode, '0x80040216', 'scripted failure');
      let answer;
      if (method === 'POST' && path === '/PublishXml') {
        publish(String(body && body.ParameterXml));
        answer = await delegate();
      } else {
        answer = route(method, path, body, options);
        if (answer === undefined) answer = await delegate();
      }
      if (mode === 'afterCommit') throw lost();
      return answer;
    };
    return {
      get: (url, options) => handle('GET', url, undefined, options, () => base.get(url, options)),
      post: (url, body, options) => handle('POST', url, body, options, () => base.post(url, body, options)),
      patch: (url, body, options) => handle('PATCH', url, body, options, () => base.patch(url, body, options)),
      put: (url, body, options) => handle('PUT', url, body, options, () => base.put(url, body, options)),
      delete: (url, options) => handle('DELETE', url, undefined, options, () => base.delete(url, options)),
      // The app's guarded publish is a `$batch` change set the pin server applies (or refuses on its guard): only when
      // it was applied does the app publish reach the theme rows.
      postRaw: async (url, text, ...rest) => {
        theme.requests.push(`BATCH ${(String(text).match(/^(?:GET|POST|PATCH|DELETE) \S+/gm) || []).map((line) => line.replace(/https?:\/\/[^/]+\/api\/data\/v9\.\d+/, '')).join(' | ')}`);
        const answer = await base.postRaw(url, text, ...rest);
        if (!/HTTP\/1\.1 412/.test(String(answer && answer.body))) publishApps(text);
        return answer;
      },
    };
  };

  const server = appPinServer(t, { ...pin, wrapHttp: wrap, sdkOptions: { solutionUniqueName: SOLUTION } });
  return {
    ...server,
    theme,
    // Every request that changes something, theme or app, in order, as `METHOD /path …` (bodies kept).
    writes: () => theme.requests.filter((line) => !line.startsWith('GET ')),
    failNext: (match, mode) => theme.fail.push({ match, mode }),
    themeRow: () => theme.rows.find((candidate) => candidate.app === APP && candidate.def === THEME_DEF),
  };
}

module.exports = { appThemeServer, THEME_DEF, SENTINEL, SOLUTION };

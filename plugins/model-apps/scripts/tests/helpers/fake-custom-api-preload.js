'use strict';

// Runs the discovery CLI over the real Dataverse request code without acquiring a real token or
// reaching a service. The fake honors $select/$expand and the bounded table/privacy filters; it
// deliberately does not remove unsupported request/response types, which discovery must reject.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const auth = require(path.join(__dirname, '..', '..', 'lib', 'dataverse-auth.js'));
const realRequest = auth.dataverseRequest;
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_CUSTOM_API_FIXTURE, 'utf8'));
const requests = [];
const API_FIELDS = new Set([
  'customapiid', 'uniquename', 'name', 'displayname', 'isfunction',
  'bindingtype', 'boundentitylogicalname', 'isprivate',
]);
const NAV_FIELDS = {
  CustomAPIRequestParameters: new Set(['uniquename', 'type', 'isoptional', 'logicalentityname']),
  CustomAPIResponseProperties: new Set(['type']),
};

process.on('exit', () => {
  fs.writeFileSync(process.env.FAKE_CUSTOM_API_LOG, JSON.stringify(requests));
});

function project(row, fields) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
}

function selectedFields(raw, allowed) {
  assert.equal(typeof raw, 'string', 'the metadata query must declare its selected fields');
  const fields = raw.split(',');
  assert.ok(fields.length > 0 && fields.every((field) => allowed.has(field)), `unexpected selected fields: ${raw}`);
  return fields;
}

function answer(request) {
  requests.push({ method: request.method, url: request.url, body: request.body });
  assert.equal(requests.length, 1, 'discovery must use one inline metadata read');
  assert.equal(request.method, 'GET');
  assert.equal(request.body, null);
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://contoso.crm.dynamics.com');
  assert.equal(url.pathname, '/api/data/v9.2/customapis');
  if (fixture.refuse) {
    return { statusCode: fixture.refuse.status, body: JSON.stringify({ error: { message: fixture.refuse.message } }) };
  }

  const select = selectedFields(url.searchParams.get('$select'), API_FIELDS);
  const filter = url.searchParams.get('$filter') || '';
  assert.match(filter, /bindingtype eq 0/);
  // OData string literals double embedded quotes, e.g. boundentitylogicalname eq 'o''brien'.
  const entities = [...filter.matchAll(/boundentitylogicalname eq '((?:''|[^'])*)'/g)]
    .map((match) => match[1].replace(/''/g, "'"));
  const expansion = url.searchParams.get('$expand') || '';
  const expanded = [...expansion.matchAll(/(?:^|,)(\w+)\(\$select=([a-z,]+)\)/g)];
  assert.equal(expanded.map((match) => match[0]).join(''), expansion, 'unexpected metadata expansion syntax');
  const navigations = expanded.map(([, navigation, fields]) => {
    assert.ok(Object.hasOwn(NAV_FIELDS, navigation), `unexpected navigation: ${navigation}`);
    return [navigation, selectedFields(fields, NAV_FIELDS[navigation])];
  });
  if (Object.hasOwn(fixture, 'responseBody')) {
    return { statusCode: 200, body: JSON.stringify(fixture.responseBody) };
  }
  const rows = (fixture.apis || [])
    .filter((row) => Number(row.bindingtype) === 0 || entities.includes(row.boundentitylogicalname))
    .filter((row) => !/\bisprivate eq false\b/.test(filter) || row.isprivate === false)
    .map((row) => {
      const projected = project(row, select);
      for (const [navigation, fields] of navigations) {
        projected[navigation] = (row[navigation] || []).map((parameter) => project(parameter, fields));
      }
      if (fixture.unreadable) {
        const { navigation, missing, value } = fixture.unreadable;
        if (missing) delete projected[navigation];
        else projected[navigation] = value;
      }
      return projected;
    });
  return { statusCode: 200, body: JSON.stringify({ value: rows }) };
}

auth.dataverseRequest = (envUrl, method, apiPath, body, options = {}) => realRequest(envUrl, method, apiPath, body, {
  ...options,
  getToken: () => 'test-token',
  request: async (request) => answer(request),
});

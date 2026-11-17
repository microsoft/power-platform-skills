const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('node:vm');

const { createTempProject, writeProjectFile } = require('./test-utils');

const VALIDATOR_PATH = path.join(
  __dirname,
  '..',
  '..',
  'skills',
  'add-server-logic',
  'scripts',
  'validate-serverlogic.js'
);

function runValidator(projectRoot) {
  const input = JSON.stringify({ cwd: projectRoot });
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    input,
    encoding: 'utf8',
  });
}

function setupProject(projectRoot) {
  writeProjectFile(projectRoot, 'powerpages.config.json', '{}');
}

function writeServerLogic(projectRoot, name, jsContent, ymlContent) {
  const dir = `.powerpages-site/server-logic/${name}`;
  writeProjectFile(projectRoot, `${dir}/${name}.js`, jsContent);
  if (ymlContent) {
    writeProjectFile(projectRoot, `${dir}/${name}.serverlogic.yml`, ymlContent);
  }
}

const VALID_YML = `adx_serverlogic_adx_webrole:
  - 11111111-1111-1111-1111-111111111111
description: Test endpoint
display_name: Test
id: 22222222-2222-2222-2222-222222222222
name: test-endpoint`;

const VALID_JS = `function get() {
    try {
        Server.Logger.Log("test-endpoint GET called");
        return JSON.stringify({ status: "success" });
    } catch (err) {
        Server.Logger.Error("test-endpoint GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}`;

test('valid server logic passes validation', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  writeServerLogic(projectRoot, 'test-endpoint', VALID_JS, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('async function without await is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const asyncNoAwaitJs = `async function get() {
    try {
        Server.Logger.Log("test-endpoint GET called");
        var records = Server.Connector.Dataverse.RetrieveMultipleRecords("contacts", "?$top=10");
        return JSON.stringify({ status: "success", data: records });
    } catch (err) {
        Server.Logger.Error("test-endpoint GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}`;
  writeServerLogic(projectRoot, 'test-endpoint', asyncNoAwaitJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /function 'get' is marked async but contains no await/);
});

test('async function with await passes validation', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const asyncWithAwaitJs = `async function post() {
    try {
        Server.Logger.Log("test-endpoint POST called");
        var response = await Server.Connector.HttpClient.PostAsync("https://api.example.com/data", JSON.stringify({ key: "value" }));
        return JSON.stringify({ status: "success", data: response });
    } catch (err) {
        Server.Logger.Error("test-endpoint POST failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}`;
  writeServerLogic(projectRoot, 'test-endpoint', asyncWithAwaitJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('missing js file is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const dir = path.join(projectRoot, '.powerpages-site', 'server-logic', 'test-endpoint');
  fs.mkdirSync(dir, { recursive: true });
  writeProjectFile(projectRoot, '.powerpages-site/server-logic/test-endpoint/test-endpoint.serverlogic.yml', VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing \.js file/);
});

test('missing yml file is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  writeServerLogic(projectRoot, 'test-endpoint', VALID_JS, null);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing metadata file/);
});

test('missing try/catch is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const noTryCatchJs = `function get() {
    Server.Logger.Log("test-endpoint GET called");
    return JSON.stringify({ status: "success" });
}`;
  writeServerLogic(projectRoot, 'test-endpoint', noTryCatchJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing try\/catch/);
});

test('disallowed function name is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const badFnJs = `function get() {
    try {
        Server.Logger.Log("test-endpoint GET called");
        return JSON.stringify({ status: "success" });
    } catch (err) {
        Server.Logger.Error("test-endpoint GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}

function helper() {
    return "not allowed";
}`;
  writeServerLogic(projectRoot, 'test-endpoint', badFnJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /found additional top-level functions: helper/);
});

test('nested helper function inside handler is not flagged as disallowed', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const nestedHelperJs = `function get() {
    try {
        function buildResponse(data) { return JSON.stringify({ status: "success", data: data }); }
        Server.Logger.Log("test-endpoint GET called");
        return buildResponse("hello");
    } catch (err) {
        Server.Logger.Error("test-endpoint GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}`;
  writeServerLogic(projectRoot, 'test-endpoint', nestedHelperJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('module.exports usage is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const exportsJs = `function get() {
    try {
        Server.Logger.Log("test-endpoint GET called");
        return JSON.stringify({ status: "success" });
    } catch (err) {
        Server.Logger.Error("test-endpoint GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}

module.exports.get = get;`;
  writeServerLogic(projectRoot, 'test-endpoint', exportsJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /module\.exports\/exports assignments are not allowed/);
});

test('try without catch is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const tryFinallyJs = `function get() {
    try {
        Server.Logger.Log("test-endpoint GET called");
        return JSON.stringify({ status: "success" });
    } finally {
        Server.Logger.Log("cleanup");
    }
}`;
  writeServerLogic(projectRoot, 'test-endpoint', tryFinallyJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing a catch block/);
});

test('yml name mismatch is flagged', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const mismatchYml = VALID_YML.replace('name: test-endpoint', 'name: wrong-name');
  writeServerLogic(projectRoot, 'test-endpoint', VALID_JS, mismatchYml);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not match folder name/);
});

test('startswith( inside string literal is flagged (with-pattern)', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const startsWithJs = `function get() {
    try {
        Server.Logger.Log("test-endpoint GET called");
        var query = "$filter=startswith(name,'INV-')";
        return JSON.stringify({ status: "success", query: query });
    } catch (err) {
        Server.Logger.Error("test-endpoint GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}`;
  writeServerLogic(projectRoot, 'test-endpoint', startsWithJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contains the substring 'with\('/);
});

test('split startswith( workaround passes validation', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  const splitJs = `function get() {
    try {
        Server.Logger.Log("test-endpoint GET called");
        var query = "$filter=startswith" + "(name,'INV-')";
        return JSON.stringify({ status: "success", query: query });
    } catch (err) {
        Server.Logger.Error("test-endpoint GET failed: " + err.message);
        return JSON.stringify({ status: "error", message: err.message });
    }
}`;
  writeServerLogic(projectRoot, 'test-endpoint', splitJs, VALID_YML);

  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

test('with-pattern rejects mixed-case substrings in raw source', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  writeServerLogic(projectRoot, 'test-endpoint', VALID_JS.replace(
    '"test-endpoint GET called"', '"STARTSWITH(name)"'
  ), VALID_YML);
  const result = runValidator(projectRoot);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contains the substring 'with\('/);
});

test('runtime function pattern is rejected in callbacks and raw non-code text', (t) => {
  for (const source of [
    'const rows = [1].map(function (r) { return r; });',
    'const rows = [1].sort(function(a, b) { return a - b; });',
    'const callback = function\n(r) { return r; };',
    'const factory = Function ("return 1");',
    'const text = "FUNCTION(";',
    '// callback: function (r)',
    'const text = "myFunction(";',
  ]) {
    const projectRoot = createTempProject(t);
    setupProject(projectRoot);
    writeServerLogic(projectRoot, 'test-endpoint', VALID_JS.replace(
      '        return JSON.stringify',
      `        ${source}\n        return JSON.stringify`
    ), VALID_YML);

    const result = runValidator(projectRoot);
    assert.equal(result.status, 2, source);
    assert.match(result.stderr, /prohibited pattern.*Function\\s\*\\\(/);
    assert.match(result.stderr, /line\(s\) 4/);
    assert.match(result.stderr, /arrow functions/);
  }
});

test('arrow callbacks and named nested helpers pass validation', (t) => {
  const projectRoot = createTempProject(t);
  setupProject(projectRoot);
  writeServerLogic(projectRoot, 'test-endpoint', VALID_JS.replace(
    '        return JSON.stringify',
    '        function double(r) { return r * 2; }\n' +
    '        const rows = [2, 1].map(r => double(r)).sort((a, b) => a - b);\n' +
    '        return JSON.stringify'
  ), VALID_YML);
  const result = runValidator(projectRoot);
  assert.equal(result.status, 0, result.stderr);
});

const SKILL_DIR = path.join(__dirname, '../../skills/add-server-logic');
const frontendReference = fs.readFileSync(path.join(
  SKILL_DIR, 'references/frontend-integration-reference.md'
), 'utf8');
const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

function exampleAfter(document, heading) {
  const start = document.indexOf(heading);
  assert.notEqual(start, -1, `Missing heading: ${heading}`);
  // Git can check Markdown out with CRLF on Windows; accept either newline at both fences.
  const example = document.slice(start).match(/```javascript\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(example, `Missing example: ${heading}`);
  return example[1];
}

function runExample(source, method, dataverse, context = {}) {
  const errors = [];
  const sandbox = {
    Server: {
      Context: context,
      Connector: { Dataverse: dataverse },
      Logger: { Log() {}, Error(message) { errors.push(message); } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const payload = JSON.parse(vm.runInContext(`${method}()`, sandbox));
  return { payload, errors };
}

// The connector returns serialized HTTP metadata, with another JSON string in Body:
//   '{"StatusCode":200,"Body":"{\"value\":[...]}","Headers":{...}}'
// Writes can have an empty Body; malformed read bodies must reach the handler's catch.
function connectorResponse(status, body, headers = {}) {
  return JSON.stringify({
    StatusCode: status,
    Body: body,
    IsSuccessStatusCode: status >= 200 && status < 300,
    Headers: headers,
  });
}

test('documentation examples execute with LF and CRLF line endings', () => {
  for (const newline of ['\n', '\r\n']) {
    const document = frontendReference.replace(/\r\n/g, '\n').replace(/\n/g, newline);
    const source = exampleAfter(document, '**Approach C');
    const { payload, errors } = runExample(source, 'get', {
      RetrieveMultipleRecords: () => connectorResponse(200, '{"value":[]}'),
    });
    assert.equal(payload.status, 'success');
    assert.deepEqual(payload.contacts, []);
    assert.deepEqual(errors, []);
  }
});

test('normalized read example returns rows from a serialized connector response', () => {
  const source = exampleAfter(frontendReference, '**Approach C');
  const { payload, errors } = runExample(source, 'get', {
    RetrieveMultipleRecords: (entitySet, options) => {
      assert.equal(entitySet, 'contacts');
      assert.equal(options, '$select=contactid,firstname,lastname,emailaddress1,telephone1');
      return connectorResponse(200, JSON.stringify({
        value: [
          { contactid: '1', firstname: 'Alex' },
          { contactid: '2', firstname: 'Sam' },
          { contactid: '3', firstname: 'Taylor' },
        ],
      }));
    },
  });
  assert.equal(payload.status, 'success');
  assert.deepEqual(payload.contacts.map(row => row.id), ['1', '2', '3']);
  assert.deepEqual(errors, []);
});

test('normalized read example logs HTTP and malformed payload failures', () => {
  const source = exampleAfter(frontendReference, '**Approach C');
  for (const response of [
    connectorResponse(403, '{"error":{"message":"Forbidden"}}'),
    connectorResponse(200, 'not-json'),
    connectorResponse(200, ''),
    connectorResponse(200, '{}'),
    'not-json',
  ]) {
    const { payload, errors } = runExample(source, 'get', {
      RetrieveMultipleRecords: () => response,
    });
    assert.equal(payload.status, 'error', response);
    assert.equal(errors.length, 1, response);
  }
});

test('create example extracts a GUID from the connector header without parsing an empty body', () => {
  const source = exampleAfter(frontendReference, 'For writes, return the new id');
  const id = '11111111-2222-3333-4444-555555555555';
  for (const headerName of ['OData-EntityId', 'odata-entityid']) {
    const { payload, errors } = runExample(source, 'post', {
      CreateRecord: () => connectorResponse(204, '', {
        [headerName]: `https://contoso.crm.dynamics.com/api/data/v9.2/contacts(${id})`,
      }),
    }, { Body: '{"firstname":"Alex"}' });
    assert.equal(payload.status, 'success');
    assert.equal(payload.id, id);
    assert.deepEqual(errors, []);
  }
});

test('create example logs failed writes and missing or malformed record URLs', () => {
  const source = exampleAfter(frontendReference, 'For writes, return the new id');
  for (const response of [
    connectorResponse(403, ''),
    connectorResponse(204, ''),
    connectorResponse(204, '', { 'OData-EntityId': 'contacts(not-a-guid)' }),
  ]) {
    const { payload, errors } = runExample(source, 'post', {
      CreateRecord: () => response,
    }, { Body: '{"firstname":"Alex"}' });
    assert.equal(payload.status, 'error', response);
    assert.equal(errors.length, 1, response);
  }
});

test('validate-and-execute example reads the record body before checking a transition', () => {
  const source = exampleAfter(skill, '#### Validate-and-Execute Template');
  for (const updateStatus of [204, 403]) {
    const writes = [];
    const { payload, errors } = runExample(source, 'post', {
      RetrieveRecord: (table, id, options) => {
        assert.equal(table, '<table-name>');
        assert.equal(id, 'record-id');
        assert.equal(options, '$select=<status-field>');
        return connectorResponse(200, '{"<status-field>":"Draft"}');
      },
      UpdateRecord: (table, id, body) => {
        writes.push({ table, id, body: JSON.parse(body) });
        return connectorResponse(updateStatus, '');
      },
    }, { Body: '{"entityId":"record-id","targetStatus":"Submitted"}' });
    assert.deepEqual(writes, [{
      table: '<table-name>', id: 'record-id', body: { '<status-field>': 'Submitted' },
    }]);
    assert.equal(payload.status, updateStatus === 204 ? 'success' : 'error');
    assert.equal(errors.length, updateStatus === 204 ? 0 : 1);
  }
});

test('wrapped passthrough server and client examples preserve and parse the connector string', async () => {
  const section = frontendReference.slice(frontendReference.indexOf('**Approach B'));
  const server = exampleAfter(section, 'Server logic:');
  const client = exampleAfter(section, 'Client -');
  for (const status of [200, 403]) {
    const { payload, errors } = runExample(server, 'get', {
      RetrieveMultipleRecords: () => connectorResponse(status, '{"value":[{"contactid":"1"}]}'),
    }, { QueryParameters: { entitySetName: 'contacts' } });
    const result = vm.runInNewContext(`(async () => { ${client}\nreturn records; })()`, {
      powerPagesFetch: async () => ({ success: true, data: JSON.stringify(payload) }),
    });
    if (status === 200) {
      assert.equal(typeof payload.data, 'string');
      assert.deepEqual(JSON.parse(JSON.stringify(await result)), [{ contactid: '1' }]);
      assert.deepEqual(errors, []);
    } else {
      await assert.rejects(result, /Dataverse read failed/);
      assert.equal(errors.length, 1);
    }
  }
});

test('custom API templates parse connector status before reporting success', () => {
  const section = skill.slice(skill.indexOf('#### Custom Action Wrapping Template'));
  for (const [heading, method] of [
    ['**Unbound action:', 'post'],
    ['**Entity-bound action:', 'post'],
    ['**Unbound function (read-only, GET):', 'get'],
  ]) {
    const source = exampleAfter(section, heading);
    for (const status of [204, 403]) {
      const response = connectorResponse(status, '');
      const { payload, errors } = runExample(source, method, {
        InvokeCustomApi: () => response,
      }, { Body: '{"entityId":"record-id"}', QueryParameters: { param1: 'value' } });
      assert.equal(payload.status, status === 204 ? 'success' : 'error');
      if (status === 204) assert.equal(payload.data, response);
      assert.equal(errors.length, status === 204 ? 0 : 1);
    }
  }
});

test('server-side guidance examples pass the local validator', (t) => {
  const customSection = skill.slice(skill.indexOf('#### Custom Action Wrapping Template'));
  for (const source of [
    exampleAfter(frontendReference, '**Approach A'),
    exampleAfter(frontendReference, '**Approach B'),
    exampleAfter(frontendReference, '**Approach C'),
    exampleAfter(frontendReference, 'For writes, return the new id'),
    exampleAfter(skill, '#### Validate-and-Execute Template'),
    exampleAfter(customSection, '**Unbound action:'),
    exampleAfter(customSection, '**Entity-bound action:'),
    exampleAfter(customSection, '**Unbound function (read-only, GET):'),
  ]) {
    const projectRoot = createTempProject(t);
    setupProject(projectRoot);
    writeServerLogic(projectRoot, 'test-endpoint', source, VALID_YML);
    const result = runValidator(projectRoot);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('troubleshooting example captures inline logs or a trace identifier', async () => {
  const source = exampleAfter(skill, 'If `browser_network_requests`');
  for (const responseHeaders of [
    { 'x-ms-user-trace': Buffer.from('{"logs":[]}').toString('base64') },
    { 'x-ms-user-trace-id': 'example-trace-id' },
    {},
  ]) {
    const result = await vm.runInNewContext(`(async () => { ${source} })()`, {
      fetch: async () => ({
        status: 400,
        headers: new Headers(responseHeaders),
        text: async () => '{"success":false}',
      }),
    });
    assert.equal(result.status, 400);
    assert.equal(result.trace, responseHeaders['x-ms-user-trace'] ?? null);
    assert.equal(result.traceId, responseHeaders['x-ms-user-trace-id'] ?? null);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

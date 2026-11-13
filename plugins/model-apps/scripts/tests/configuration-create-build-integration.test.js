'use strict';
// The default build's configuration creates end to end (#807): the build COMMAND (build-model-app.js main) with the SDKs it makes
// itself over the real maker-SDK bundle (makeSdk attaches the create bridge), the real configuration runtime and the new writer,
// against the strict in-memory org (helpers/fake-config-org.js). Nothing is an injected create port: every request the org sees is
// one the build itself decided to send.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { runCommand: runCommandIn } = require('./helpers/configuration-command.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { configurationSendOnce } = require('../lib/configuration-transport.js');
const { attachConfigurationCreateBridge } = require('../lib/configuration-create-writer.js');
const { buildModelApp } = require('../build-model-app.js');
const { STAGES } = require('../lib/stages.js');
const { STATE_FILE } = require('../lib/configuration-create-state.js');
const { CONFIGURATION_CREATE_KIND_TABLE } = require('../lib/configuration-create-plan.js');

const SOL = 'ContosoSol';
const CONFIG_SET = /^\/(environmentvariabledefinitions|environmentvariablevalues|connectionreferences|customapis|customapirequestparameters|customapiresponseproperties|duplicaterules|duplicateruleconditions)\b/;
const ID_COLUMN = Object.fromEntries(Object.values(CONFIGURATION_CREATE_KIND_TABLE).map((k) => [k.entitySet, k.idColumn]));
const PUBLISH = /^\/duplicaterules\([^)]+\)\/Microsoft\.Dynamics\.CRM\.PublishDuplicateRule$/;
// RFC 9562 version-5 (name-based) ids: what the stable create plan derives. A random (version-4) id is what an SDK push mints.
const V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const makeSpec = (over = {}) => ({
  minimumPluginVersion: '2.21.0', schemaVersion: 2,
  solution: { uniqueName: SOL, displayName: 'Contoso Sol', publisherPrefix: 'contoso', version: '1.2.0.0' },
  app: { name: 'Config Probe', uniqueName: 'contoso_configprobe' }, entities: [],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Links', subAreas: [{ url: 'https://contoso.example/help', title: 'Help' }] }] }] },
  environmentVariables: [{ schemaName: 'contoso_ApiBase', type: 'string', defaultValue: 'https://api.contoso.com' }, { schemaName: 'contoso_ApiKey', type: 'secret' }],
  customApis: [{ uniqueName: 'contoso_Calc', isFunction: true, requestParameters: [{ uniqueName: 'A', type: 'integer' }], responseProperties: [{ uniqueName: 'R', type: 'string' }] }],
  duplicateDetectionRules: [
    { key: 'email', name: 'Contacts with same email', entity: 'contact', conditions: [{ key: 'e', column: 'emailaddress1', match: 'exact' }] },
    { key: 'last', name: 'Contacts with same last name', entity: 'contact', status: 'unpublished', conditions: [{ key: 'l', column: 'lastname', match: 'exact' }] },
  ],
  ...over,
});
const orgOf = () => createConfigOrg({ tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' } });
const runCommand = (spec, { org = orgOf(), appDir = path.join(makeTempDir('cfg-create-int-'), 'app'), ...o } = {}) => runCommandIn(spec, { org, appDir, ...o });
const solutionHeaderOf = (headers) => {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === 'mscrm.solutionuniquename');
  return k === undefined ? undefined : headers[k];
};
const configWrites = (org, since = 0) => org.requests.slice(since).filter((q) => q.method !== 'GET' && (CONFIG_SET.test(q.path) || PUBLISH.test(q.path)));
const failed = (out) => `${out.thrown ? out.thrown.stack : ''} ${out.stderr.slice(-1500)}`;
function receiptsIn(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === STATE_FILE) out.push(p); } };
  walk(dir);
  return out.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
}
// A transport whose answer to the first request `lose(req)` picks is lost after the org committed it (the socket closes).
function losing(org, lose) {
  let done = false;
  return { origin: org.origin, requests: org.requests, rows: org.rows, writes: org.writes, unexpected: org.unexpected, sets: org.sets,
    async request(req) {
      const where = decodeURIComponent(new URL(req.url).pathname).replace(/^\/api\/data\/v9\.\d/, '');
      const answer = await org.request(req);
      if (!done && lose({ method: String(req.method).toUpperCase(), path: where })) { done = true; throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
      return answer;
    } };
}

test('a clean build creates every new configuration row as one flat POST at a stable id, publishes the new rule once without a header, and keeps no open receipt', async () => {
  const out = await runCommand(makeSpec());
  assert.equal(out.exitCode, 0, failed(out));
  const writes = configWrites(out.org);
  const posts = writes.filter((q) => !PUBLISH.test(q.path));
  assert.ok(posts.length >= 9, 'two definitions, an API with two children, two rules with one condition each');
  for (const q of posts) {
    assert.equal(q.method, 'POST', `${q.method} ${q.path}`);
    assert.doesNotMatch(q.path, /[?(]/, `a flat POST with no query and no key: ${q.path}`);
    assert.ok(Object.values(q.body).every((v) => !Array.isArray(v) && !(v && typeof v === 'object')), `no nested row in ${q.path}`);
    const id = q.body[ID_COLUMN[q.path.slice(1)]];
    assert.ok(V5.test(String(id)), `${q.path}: the body names a stable id (${id})`);
    assert.equal(solutionHeaderOf(q.headers), q.path === '/environmentvariablevalues' ? undefined : SOL, `${q.path}: the header matrix`);
  }
  const publications = writes.filter((q) => PUBLISH.test(q.path));
  assert.equal(publications.length, 1, 'the new published rule only');
  assert.equal(solutionHeaderOf(publications[0].headers), undefined);
  assert.equal(out.org.rows('duplicaterules').find((r) => r.name === 'Contacts with same email').statecode, 1);
  assert.equal(out.org.rows('duplicaterules').find((r) => r.name === 'Contacts with same last name').statecode, 0);
  for (const r of receiptsIn(out.appDir)) assert.deepEqual(r.units, [], 'no open unit');
  assert.deepEqual(out.org.unexpected, []);
  // The same build again: nothing to create, nothing sent.
  const mark = out.org.requests.length;
  const again = await runCommand(makeSpec(), { org: out.org, appDir: out.appDir });
  assert.equal(again.exitCode, 0, failed(again));
  assert.deepEqual(configWrites(out.org, mark), []);
});

test('a lost answer to a committed create stops the build pending; the next build stops before any request and never creates at a fresh id', async () => {
  const org = losing(orgOf(), ({ method, path: p }) => method === 'POST' && p === '/customapis');
  const first = await runCommand(makeSpec(), { org });
  assert.notEqual(first.exitCode, 0);
  assert.match(failed(first), /configuration-create-pending/);
  assert.equal(org.rows('customapis').length, 1);
  assert.equal(configWrites(org).filter((q) => q.path === '/customapis').length, 1, 'sent once');
  const [receipt] = receiptsIn(first.appDir);
  assert.equal(receipt.units.length, 1, 'the receipt keeps the unit');
  assert.equal(receipt.units[0].root.kind, 'custom-api');
  const mark = org.requests.length;
  const second = await runCommand(makeSpec(), { org, appDir: first.appDir });
  assert.notEqual(second.exitCode, 0);
  assert.match(failed(second), /configuration-create-pending/);
  assert.deepEqual(configWrites(org, mark), [], 'the next build sends no configuration write');
  assert.deepEqual(org.requests.slice(mark).filter((q) => CONFIG_SET.test(q.path)).map((q) => `${q.method} ${q.path}`), [], 'nor reads one: it stops on the receipt alone');
  assert.equal(org.rows('customapis').length, 1, 'no second Custom API at a fresh id');
});

test('additions only: a new condition of an unpublished rule is one flat POST; of a published rule it stops mixed-edit with nothing sent', async () => {
  const out = await runCommand(makeSpec());
  assert.equal(out.exitCode, 0, failed(out));
  const withCondition = (key) => makeSpec({ duplicateDetectionRules: makeSpec().duplicateDetectionRules.map((r) => (r.key === key ? { ...r, conditions: [...r.conditions, { key: 'n', column: 'lastname', match: 'firstCharacters', characters: 2 }] } : r)) });
  let mark = out.org.requests.length;
  const added = await runCommand(withCondition('last'), { org: out.org, appDir: out.appDir });
  assert.equal(added.exitCode, 0, failed(added));
  const writes = configWrites(out.org, mark);
  assert.deepEqual(writes.map((q) => `${q.method} ${q.path}`), ['POST /duplicateruleconditions'], 'the new condition only: no rule rewrite, no publication');
  assert.ok(V5.test(writes[0].body.duplicateruleconditionid));
  assert.equal(out.org.rows('duplicaterules').find((r) => r.name === 'Contacts with same last name').statecode, 0);
  mark = out.org.requests.length;
  const refused = await runCommand(withCondition('email'), { org: out.org, appDir: out.appDir });
  assert.notEqual(refused.exitCode, 0);
  assert.match(failed(refused), /configuration-create-mixed-edit/);
  assert.deepEqual(configWrites(out.org, mark), [], 'nothing sent: a condition added to a published rule would unpublish it');
  assert.equal(out.org.rows('duplicaterules').find((r) => r.name === 'Contacts with same email').statecode, 1);
});

test('a preserved row edited in the same build as a new child is refused before the first mutation', async () => {
  const out = await runCommand(makeSpec());
  assert.equal(out.exitCode, 0, failed(out));
  const [api] = makeSpec().customApis;
  const mixed = makeSpec({ customApis: [{ ...api, displayName: 'Calculate', requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'string' }] }] });
  const mark = out.org.requests.length;
  const refused = await runCommand(mixed, { org: out.org, appDir: out.appDir });
  assert.notEqual(refused.exitCode, 0);
  assert.match(failed(refused), /configuration-create-mixed-edit/);
  assert.deepEqual(out.org.writes(mark), [], 'no request changed anything');
});

test('membership: every new row but a value is a member of the solution, no component is added twice, a value row never is, and a rerun adds nothing', async () => {
  const out = await runCommand(makeSpec());
  assert.equal(out.exitCode, 0, failed(out));
  const adds = out.org.requests.filter((q) => q.method === 'POST' && q.path === '/AddSolutionComponent').map((q) => String(q.body.ComponentId).toLowerCase());
  assert.equal(new Set(adds).size, adds.length, 'each component is added at most once');
  const created = configWrites(out.org).filter((q) => !PUBLISH.test(q.path)).map((q) => ({ set: q.path.slice(1), id: String(q.body[ID_COLUMN[q.path.slice(1)]]).toLowerCase() }));
  const members = new Set(out.org.rows('solutioncomponents').map((r) => String(r.objectid).toLowerCase()));
  for (const { set, id } of created) {
    if (set === 'environmentvariablevalues') {
      assert.ok(!adds.includes(id), 'a value row is never offered for membership');
      assert.ok(!members.has(id), 'nor joined by a header');
    } else {
      assert.ok(members.has(id), `${set} ${id} is a member of the solution`);
    }
  }
  const mark = out.org.requests.length;
  const again = await runCommand(makeSpec(), { org: out.org, appDir: out.appDir });
  assert.equal(again.exitCode, 0, failed(again));
  assert.deepEqual(out.org.requests.slice(mark).filter((q) => q.path === '/AddSolutionComponent'), [], 'a rerun adds no component');
});
test('a dry run sends no write and leaves no receipt', async () => {
  const out = await runCommand(makeSpec(), { apply: false });
  assert.equal(out.exitCode, 0, failed(out));
  assert.deepEqual(out.org.writes(0), []);
  assert.deepEqual(fs.existsSync(out.appDir) ? receiptsIn(out.appDir) : [], []);
});

test('the SDK never pushes, creates, edits or publishes a configuration artifact: create, addition and publication all go through the writer', async () => {
  const org = orgOf();
  const httpClient = createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: org.request, sleep: async () => {}, sendOnce: configurationSendOnce });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('cfg-create-int-sdk-')), instanceUrl: org.origin, httpClient, solutionUniqueName: SOL });
  await sdk.initWorkspace();
  const calls = [];
  for (const name of ['createArtifact', 'pushArtifact', 'pushArtifactUnlocked', 'pushAll', 'addElement', 'updateElement', 'removeElement', 'publishArtifact', 'publishArtifacts', 'deleteArtifact', 'createRecord', 'updateRecord']) {
    const real = sdk[name].bind(sdk);
    sdk[name] = (...args) => { calls.push(`${name} ${JSON.stringify(args[0])}`); return real(...args); };
  }
  const workspaceDir = makeTempDir('cfg-create-int-ws-');
  attachConfigurationCreateBridge(sdk, { httpClient, apiUrl: (p) => sdk.dataverse.apiUrl(p), sleep: async () => {} });
  const build = (spec) => buildModelApp(spec, { apply: true, env: org.origin, phases: STAGES.data, workspaceDir, retryDelayMs: 0 }, { sdk, log: () => {}, warn: () => {} });
  const first = await build(makeSpec());
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const second = await build(makeSpec({ customApis: [{ ...makeSpec().customApis[0], requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'string' }] }] }));
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.equal(org.rows('customapirequestparameters').length, 2);
  assert.deepEqual(calls.filter((c) => /environment|connection|customapi|duplicate/i.test(c)), []);
  assert.equal(org.requests.filter((q) => PUBLISH.test(q.path)).length, 1);
});

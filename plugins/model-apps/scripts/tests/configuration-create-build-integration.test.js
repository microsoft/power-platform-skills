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
    // The spy refuses as well as records: a configuration write the SDK was asked to make fails the build, whatever catches it.
    sdk[name] = (...args) => {
      const call = `${name} ${JSON.stringify(args[0])}`;
      calls.push(call);
      if (/environment|connection|customapi|duplicate/i.test(call)) throw new Error(`the SDK was asked to write configuration: ${name}`);
      return real(...args);
    };
  }
  const workspaceDir = makeTempDir('cfg-create-int-ws-');
  // Required here, not at the top, so the rest of this file depends on the build's requests alone, not on this module.
  const { attachConfigurationCreateBridge } = require('../lib/configuration-create-writer.js');
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

// Every applied-state snapshot the build left under the app folder (lib/apply-snapshot-store.js SNAPSHOT_FILE), parsed.
function snapshotsIn(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'apply-snapshot.json') out.push(p); } };
  walk(dir);
  return out.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
}
const notEligible = (dir, why) => { for (const s of snapshotsIn(dir)) assert.notEqual(s.eligible, true, `${why}: no applied state is recorded as a success`); };

test('after a lost answer the next build sends no write of any kind, and neither build records its applied state as a success', async () => {
  const org = losing(orgOf(), ({ method, path: p }) => method === 'POST' && p === '/duplicateruleconditions');
  const first = await runCommand(makeSpec(), { org });
  assert.notEqual(first.exitCode, 0);
  assert.match(failed(first), /configuration-create-pending/);
  notEligible(first.appDir, 'the first build');
  const mark = org.requests.length;
  const second = await runCommand(makeSpec(), { org, appDir: first.appDir });
  assert.notEqual(second.exitCode, 0);
  assert.match(failed(second), /configuration-create-pending/);
  assert.deepEqual(org.writes(mark), [], 'no write of any kind: no create, no update, no membership, no publication');
  notEligible(first.appDir, 'the second build');
});

test('a preserved condition and a new one whose answer was lost: whatever then changes on the service or in the declaration, the next build sends nothing', async () => {
  const withNew = (spec) => ({ ...spec, duplicateDetectionRules: spec.duplicateDetectionRules.map((r) => (r.key === 'last' ? { ...r, conditions: [...r.conditions, { key: 'n', column: 'emailaddress1', match: 'exact' }] } : r)) });
  const ruleOf = (org) => org.rows('duplicaterules').find((r) => r.name === 'Contacts with same last name');
  const conditionsOf = (org, rule) => org.rows('duplicateruleconditions').filter((c) => String(c._regardingobjectid_value || c.regardingobjectid || '').toLowerCase() === String(rule.duplicateruleid).toLowerCase());
  const changes = [
    ['the root edited on the service', (org) => { ruleOf(org).description = 'edited elsewhere'; }, makeSpec()],
    ['the preserved condition edited on the service', (org) => { const [a] = conditionsOf(org, ruleOf(org)); a.ignoreblankvalues = true; }, makeSpec()],
    ['the preserved condition deleted on the service', (org) => { const [a] = conditionsOf(org, ruleOf(org)); org.sets.get('duplicateruleconditions').delete(a.duplicateruleconditionid); }, makeSpec()],
    ['the root edited in the declaration', () => {}, { ...makeSpec(), duplicateDetectionRules: makeSpec().duplicateDetectionRules.map((r) => (r.key === 'last' ? { ...r, name: 'Renamed' } : r)) }],
  ];
  for (const [why, change, nextSpec] of changes) {
    const base = orgOf();
    const created = await runCommand(makeSpec(), { org: base });
    assert.equal(created.exitCode, 0, failed(created));
    assert.equal(conditionsOf(base, ruleOf(base)).length, 1, `${why}: the preserved condition`);
    const org = losing(base, ({ method, path: p }) => method === 'POST' && p === '/duplicateruleconditions');
    const added = await runCommand(withNew(makeSpec()), { org, appDir: created.appDir });
    assert.notEqual(added.exitCode, 0);
    assert.match(failed(added), /configuration-create-pending/, why);
    assert.equal(conditionsOf(base, ruleOf(base)).length, 2, `${why}: the new condition was committed`);
    change(base);
    const mark = base.requests.length;
    const next = await runCommand(withNew(nextSpec), { org: base, appDir: created.appDir });
    assert.notEqual(next.exitCode, 0);
    assert.match(failed(next), /configuration-create-pending/, why);
    assert.deepEqual(base.writes(mark), [], `${why}: no write of any kind`);
  }
});

test('membership: a child that joined the solution with its create is not added again; one that did not is added once', async () => {
  const childSets = ['customapirequestparameters', 'customapiresponseproperties', 'duplicateruleconditions'];
  const childIds = (org) => new Set(configWrites(org).filter((q) => childSets.includes(q.path.slice(1))).map((q) => String(q.body[ID_COLUMN[q.path.slice(1)]]).toLowerCase()));
  const addsOf = (org) => org.requests.filter((q) => q.method === 'POST' && q.path === '/AddSolutionComponent').map((q) => String(q.body.ComponentId).toLowerCase());
  const joined = createConfigOrg({ tables: [{ logicalName: 'contact', attributes: ['emailaddress1', 'lastname'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' }, childrenJoin: true });
  const a = await runCommand(makeSpec(), { org: joined });
  assert.equal(a.exitCode, 0, failed(a));
  const kids = childIds(joined);
  assert.ok(kids.size >= 4);
  assert.deepEqual(addsOf(joined).filter((id) => kids.has(id)), [], 'no child is added: each joined with its create');
  const plain = orgOf();
  const b = await runCommand(makeSpec(), { org: plain });
  assert.equal(b.exitCode, 0, failed(b));
  const plainKids = childIds(plain);
  const members = new Set(plain.rows('solutioncomponents').map((r) => String(r.objectid).toLowerCase()));
  const added = addsOf(plain).filter((id) => plainKids.has(id));
  assert.equal(new Set(added).size, added.length, 'each at most once');
  for (const id of plainKids) assert.ok(members.has(id), `${id} is a member`);
  for (const id of added) assert.ok(plainKids.has(id));
  // Every child that is a component of its own and did not join with its create was added exactly once.
  assert.ok(added.length > 0, 'the org without header joins needed adds');
});

test('a published rule gains a condition in three builds: unpublish it, add the condition (one POST), publish it again', async () => {
  const out = await runCommand(makeSpec());
  assert.equal(out.exitCode, 0, failed(out));
  const ruleOf = () => out.org.rows('duplicaterules').find((r) => r.name === 'Contacts with same email');
  assert.equal(ruleOf().statecode, 1);
  const withEmail = (over) => makeSpec({ duplicateDetectionRules: makeSpec().duplicateDetectionRules.map((r) => (r.key === 'email' ? { ...r, ...over } : r)) });
  const condition = { key: 'n', column: 'lastname', match: 'exact' };
  let mark = out.org.requests.length;
  const unpublished = await runCommand(withEmail({ status: 'unpublished' }), { org: out.org, appDir: out.appDir, argv: ['--stage', 'data', '--allow-destructive', '--authorize', 'duplicateRule:email:status'] });
  assert.equal(unpublished.exitCode, 0, failed(unpublished));
  assert.equal(ruleOf().statecode, 0, 'unpublished');
  assert.deepEqual(configWrites(out.org, mark).filter((q) => q.path === '/duplicateruleconditions'), []);
  mark = out.org.requests.length;
  const appended = await runCommand(withEmail({ status: 'unpublished', conditions: [...withEmail({}).duplicateDetectionRules[0].conditions, condition] }), { org: out.org, appDir: out.appDir });
  assert.equal(appended.exitCode, 0, failed(appended));
  assert.deepEqual(configWrites(out.org, mark).map((q) => `${q.method} ${q.path}`), ['POST /duplicateruleconditions'], 'the new condition only');
  assert.equal(ruleOf().statecode, 0);
  mark = out.org.requests.length;
  const republished = await runCommand(withEmail({ status: 'published', conditions: [...withEmail({}).duplicateDetectionRules[0].conditions, condition] }), { org: out.org, appDir: out.appDir });
  assert.equal(republished.exitCode, 0, failed(republished));
  assert.equal(ruleOf().statecode, 1, 'published again');
  assert.deepEqual(configWrites(out.org, mark).filter((q) => q.path === '/duplicateruleconditions'), [], 'no condition created again');
  for (const r of receiptsIn(out.appDir)) assert.deepEqual(r.units, []);
});

test('a build with no configuration, and a protected build, keep no create receipt', async () => {
  const none = makeSpec();
  delete none.environmentVariables;
  delete none.customApis;
  delete none.duplicateDetectionRules;
  const plain = await runCommand(none);
  assert.equal(plain.exitCode, 0, failed(plain));
  assert.deepEqual(receiptsIn(plain.appDir), [], 'no configuration: no receipt file');
  const protectedSpec = { ...makeSpec(), configurationIdentity: 'stable-v1' };
  const guarded = await runCommand(protectedSpec);
  assert.equal(guarded.exitCode, 0, failed(guarded));
  assert.ok(configWrites(guarded.org).length > 0, 'the protected build created its rows');
  assert.deepEqual(receiptsIn(guarded.appDir), [], 'the protected route keeps its own records, not this receipt');
});

test('a declaration the compiler refuses stops the build before any request is sent or any receipt is saved', async () => {
  const A = require('../lib/configuration-artifacts.js');
  const original = A.buildArtifact;
  A.buildArtifact = (...args) => { const a = original(...args); return args[0] && args[0].kind === 'customApi' ? { ...a, hint: 'h' } : a; };
  let out;
  try {
    out = await runCommand(makeSpec());
  } finally {
    A.buildArtifact = original;
  }
  assert.notEqual(out.exitCode, 0);
  assert.match(failed(out), /configuration-create-shape-refused/);
  assert.deepEqual(configWrites(out.org), [], 'no configuration write');
  assert.deepEqual(out.org.requests.filter((q) => q.method !== 'GET' && /^\/customapi/.test(q.path)), []);
  for (const r of receiptsIn(out.appDir)) assert.deepEqual(r.units, [], 'no unit saved');
});

// The rule's lifecycle through the build command: a final graph read that contradicts the publication keeps the unit, and the
// maker following the ordinary remedy (an explicit status: 'published') gets no PATCH and no second publication; a rule that
// already reads published before its publication is never published again.
test('a new rule read unpublished at the last graph read after its publication keeps the unit, and the next build (status published) sends nothing', async () => {
  const org = orgOf();
  const original = org.request;
  let published = false;
  let reads = 0;
  org.request = async (req) => {
    const where = decodeURIComponent(new URL(req.url).pathname).replace(/^\/api\/data\/v9\.\d/, '');
    if (req.method === 'POST' && PUBLISH.test(where)) published = true;
    else if (published && req.method === 'GET' && /^\/duplicaterules\([^)]+\)$/.test(where) && ++reads === 2) Object.assign(org.rows('duplicaterules').find((r) => r.name === 'Contacts with same email'), { statecode: 0, statuscode: 0 });
    return original(req);
  };
  const first = await runCommand(makeSpec(), { org });
  const mark = org.requests.length;
  const republish = makeSpec({ duplicateDetectionRules: makeSpec().duplicateDetectionRules.map((r) => (r.key === 'email' ? { ...r, status: 'published' } : r)) });
  const again = await runCommand(republish, { org, appDir: first.appDir });
  assert.deepEqual(org.writes(mark), [], 'no PATCH, no second publication, no write of any kind');
  assert.notEqual(first.exitCode, 0);
  assert.match(failed(first), /configuration-create-publication-pending/);
  const units = receiptsIn(first.appDir).flatMap((r) => r.units);
  assert.equal(units.length, 1, 'the unit is kept');
  assert.equal(units[0].publication.dispatch, 'acknowledged');
  assert.notEqual(again.exitCode, 0);
  assert.match(failed(again), /configuration-create-publication-pending/);
  assert.equal(org.requests.filter((q) => PUBLISH.test(q.path)).length, 1, 'published once in all');
  notEligible(first.appDir, 'either build');
});

test('a new rule that already reads published before its publication is not published again, and the next build sends nothing', async () => {
  const org = orgOf();
  const original = org.request;
  let email = null;
  org.request = async (req) => {
    const where = decodeURIComponent(new URL(req.url).pathname).replace(/^\/api\/data\/v9\.\d/, '');
    const answer = await original(req);
    if (req.method === 'POST' && where === '/duplicaterules' && JSON.parse(req.body).name === 'Contacts with same email') email = JSON.parse(req.body).duplicateruleid;
    // Published by someone else as soon as its condition is committed: the graph read before the action sees it published.
    if (email && req.method === 'POST' && where === '/duplicateruleconditions' && /duplicaterules\(([^)]+)\)/.exec(JSON.parse(req.body)['regardingobjectid@odata.bind'] || '')?.[1] === email) {
      Object.assign(org.rows('duplicaterules').find((r) => r.duplicateruleid === email), { statecode: 1, statuscode: 2 });
    }
    return answer;
  };
  const first = await runCommand(makeSpec(), { org });
  const mark = org.requests.length;
  const again = await runCommand(makeSpec(), { org, appDir: first.appDir });
  assert.deepEqual(org.requests.filter((q) => PUBLISH.test(q.path)).map((q) => q.path), [], 'never published by the build');
  assert.deepEqual(org.writes(mark), [], 'the next build sends nothing');
  assert.notEqual(first.exitCode, 0);
  assert.match(failed(first), /configuration-create-publication-pending/);
  const units = receiptsIn(first.appDir).flatMap((r) => r.units);
  assert.equal(units.length, 1);
  assert.equal(units[0].publication.dispatch, 'prepared');
  assert.notEqual(again.exitCode, 0);
  notEligible(first.appDir, 'either build');
});

// The whole-build interruption matrix: for each of the eight row kinds, the first create of that kind is interrupted (its answer
// lost after the org committed it, or the request held before it reached the org and released later). The next whole build,
// with the same declaration and deployment settings, must attempt no second create of it (neither again nor at a fresh id),
// keep the receipt naming the exact attempted id, send no write of any kind, and record no applied state as a success.
const MATRIX_SET_OF = Object.fromEntries(Object.entries(CONFIGURATION_CREATE_KIND_TABLE).map(([kind, k]) => [kind, k.entitySet]));
const matrixSpec = () => makeSpec({ connectionReferences: [{ logicalName: 'contoso_c1', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' }] });
function interrupting(org, set, mode) {
  const attempts = [];
  let held = null;
  return { attempts, origin: org.origin, requests: org.requests, rows: org.rows, writes: org.writes, unexpected: org.unexpected, sets: org.sets,
    release: () => (held ? org.request(held) : null),
    async request(req) {
      const where = decodeURIComponent(new URL(req.url).pathname).replace(/^\/api\/data\/v9\.\d/, '');
      if (String(req.method).toUpperCase() !== 'POST' || where !== `/${set}`) return org.request(req);
      const body = JSON.parse(String(req.body));
      attempts.push(String(body[ID_COLUMN[set]] || '<no id>').toLowerCase());
      if (attempts.length > 1 || held) return org.request(req);
      if (mode === 'held') held = req;
      else await org.request(req);
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    } };
}
for (const kind of Object.keys(CONFIGURATION_CREATE_KIND_TABLE)) {
  for (const mode of ['lost', 'held']) {
    test(`interrupted ${kind} create (${mode === 'lost' ? 'answer lost after commit' : 'request held before commit, released later'}): the next whole build attempts it at no other id and sends no write`, async () => {
      const set = MATRIX_SET_OF[kind];
      const base = orgOf();
      const org = interrupting(base, set, mode);
      const settings = path.join(makeTempDir('cfg-create-int-settings-'), 'settings.json');
      fs.writeFileSync(settings, JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'contoso_ApiBase', Value: 'https://api.contoso.com/v2' }] }));
      const argv = ['--stage', 'data', '--allow-destructive', '--deployment-settings', settings];
      const first = await runCommand(matrixSpec(), { org, argv });
      const receiptAfterFirst = receiptsIn(first.appDir);
      const mark = base.requests.length;
      const second = await runCommand(matrixSpec(), { org, appDir: first.appDir, argv });
      // The unsafe second attempt (again, or at a fresh id) is what this proves absent, so it is asserted first.
      assert.equal(org.attempts.length, 1, `exactly one ${set} create across both builds: ${JSON.stringify(org.attempts)}`);
      const [id] = org.attempts;
      assert.match(id, V5, 'at its stable id');
      assert.notEqual(first.exitCode, 0, 'the interrupted build did not succeed');
      assert.match(failed(first), /configuration-create-pending/);
      const units = receiptAfterFirst.flatMap((r) => r.units);
      assert.equal(units.length, 1, 'one open unit');
      const row = units[0].rows.find((r) => r.id === id);
      assert.ok(row, 'the receipt names the exact attempted id');
      assert.equal(row.kind, kind);
      assert.equal(row.dispatch, 'dispatched');
      assert.notEqual(second.exitCode, 0);
      assert.match(failed(second), /configuration-create-pending/);
      assert.deepEqual(base.writes(mark), [], 'the next build sends no write of any kind');
      assert.deepEqual(receiptsIn(first.appDir), receiptAfterFirst, 'the receipt is kept as it was');
      notEligible(first.appDir, 'either build');
      if (mode === 'held') {
        // The held request lands only now (a read in between would have answered 404): one row at the attempted id, and a
        // third build still sends nothing.
        await org.release();
        assert.equal(base.rows(set).filter((r) => String(r[ID_COLUMN[set]]).toLowerCase() === id).length, 1);
        const after = base.requests.length;
        const third = await runCommand(matrixSpec(), { org, appDir: first.appDir, argv });
        assert.notEqual(third.exitCode, 0);
        assert.deepEqual(base.writes(after), []);
        assert.equal(org.attempts.length, 1);
      }
    });
  }
}

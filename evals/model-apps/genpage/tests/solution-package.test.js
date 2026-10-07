'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PHASE_EXPECTATIONS, WORKFLOW_ASSERTIONS } = require('../lib/assertions-layer-1.js');

const RULE = 'Phase 6.7: Packaging uses every deployed page id, the approved solution and discovered component types; invalid identities refuse before writes and results agree with read-back';
const APP = '11111111-1111-4111-8111-111111111111';
const SOLUTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGES = [
  { file: 'list.tsx', pageId: '22222222-2222-4222-8222-222222222222' },
  { file: 'schedule.tsx', pageId: '33333333-3333-4333-8333-333333333333' },
  { file: 'metrics.tsx', pageId: '44444444-4444-4444-8444-444444444444' },
];

function packageFixture() {
  const added = [{ type: 'appmodule', id: APP }, ...PAGES.map((page) => ({ type: 'uxagentproject', id: page.pageId })), { type: 'connectionreference', logicalName: 'cnt_docs', id: REF }];
  const requests = [
    { method: 'GET', path: "EntityDefinitions(LogicalName='uxagentproject')?$select=ObjectTypeCode", response: { status: 200, data: { ObjectTypeCode: 10401 } } },
    { method: 'GET', path: "EntityDefinitions(LogicalName='connectionreference')?$select=ObjectTypeCode", response: { status: 200, data: { ObjectTypeCode: 10402 } } },
    { method: 'GET', path: "connectionreferences?$filter=connectionreferencelogicalname eq 'cnt_docs'&$select=connectionreferenceid&$top=1", response: { status: 200, data: { value: [{ connectionreferenceid: REF }] } } },
    ...added.map((entry) => ({
      method: 'POST', path: 'AddSolutionComponent',
      body: { ComponentId: entry.id, ComponentType: entry.type === 'appmodule' ? 80 : entry.type === 'uxagentproject' ? 10401 : 10402, SolutionUniqueName: 'ContosoPages', AddRequiredComponents: entry.type !== 'connectionreference' },
      response: { status: 204, data: {} },
    })),
  ];
  return {
    contractVersion: 2,
    genpagePlan: '## Solution Packaging\n- Package into solution: true\n- Solution: ContosoPages\n',
    workflowLog: 'Phase 6.7: package successful; checked read-back.',
    artifacts: { 'configs/list.json': '{"connectorBindings":[{"logicalName":"cnt_docs"}]}' },
    manifest: { packaging: {
      solution: 'ContosoPages', solutionId: SOLUTION, appId: APP, pages: structuredClone(PAGES), configs: ['configs/list.json'], connectionReferences: ['cnt_docs'],
      attempts: [{ event: 'package', outcome: 'success', readback: 'readback' }],
    } },
    events: [
      ...PAGES.map((page, index) => ({ id: `deploy-${index}`, command: `node genpage-upload.js --app-id ${APP} --code-file ${page.file} --add-to-sitemap`, result: { ok: true, appId: APP, pageId: page.pageId } })),
      { id: 'solution', command: 'node provision-solution.js https://contoso.crm.dynamics.com ContosoPages Contoso', result: { ok: true, uniqueName: 'ContosoPages', solutionId: SOLUTION } },
      { id: 'package', command: `node add-page-to-solution.js https://contoso.crm.dynamics.com ContosoPages ${APP} --page-ids ${PAGES.map((page) => page.pageId).join(',')} --connection-refs cnt_docs`, requests, result: { ok: true, added } },
      { id: 'readback', command: `node dataverse-request.js https://contoso.crm.dynamics.com GET "solutioncomponents?$filter=_solutionid_value eq ${SOLUTION}&$select=objectid,componenttype"`, result: { ok: true, data: { value: requests.filter((request) => request.method === 'POST').map((request) => ({ objectid: request.body.ComponentId, componenttype: request.body.ComponentType })) } } },
    ],
  };
}

function score(fixture) {
  const check = PHASE_EXPECTATIONS.get(RULE);
  assert.equal(typeof check, 'function', 'solution packaging scorer must be registered');
  return check({ fixture, eval: { id: 25 } });
}

test('packaging uses every deployed page and refuses invalid identities', () => {
  const good = packageFixture();
  assert.equal(score(good).status, 'pass');
  for (const mutate of [
    (fixture) => { fixture.events.find((call) => call.id === 'package').command = fixture.events.find((call) => call.id === 'package').command.replace(`,${PAGES[2].pageId}`, ''); },
    (fixture) => { fixture.events.find((call) => call.id === 'package').command = fixture.events.find((call) => call.id === 'package').command.replace('ContosoPages', 'WrongSolution'); },
    (fixture) => { fixture.events.find((call) => call.id === 'package').requests[4].body.ComponentType = 80; },
    (fixture) => { const requests = fixture.events.find((call) => call.id === 'package').requests; [requests[3], requests[4]] = [requests[4], requests[3]]; },
    (fixture) => { fixture.events.find((call) => call.id === 'package').requests[4].body.AddRequiredComponents = false; },
    (fixture) => { fixture.events.find((call) => call.id === 'readback').result.data.value.pop(); },
    (fixture) => { fixture.events.find((call) => call.id === 'package').result.added.pop(); },
    (fixture) => { fixture.events[0].result.pageId = APP; },
    (fixture) => { fixture.events.find((call) => call.id === 'package').command += ' --unknown true'; },
  ]) {
    const bad = packageFixture();
    mutate(bad);
    assert.equal(score(bad).status, 'fail');
  }

  for (const invalid of ['bad-app-id', 'bad-page-id']) {
    const refused = packageFixture();
    const call = refused.events.find((entry) => entry.id === 'package');
    call.command = invalid === 'bad-app-id' ? call.command.replace(APP, invalid) : call.command.replace(PAGES[0].pageId, invalid);
    call.requests = [];
    call.result = { ok: false, error: 'Not a GUID. Nothing was added to ContosoPages.' };
    call.userMessage = call.result.error;
    refused.manifest.packaging.attempts = [{ event: 'package', outcome: 'refused' }];
    assert.equal(score(refused).status, 'pass');
    call.requests = [{ method: 'POST', path: 'AddSolutionComponent', body: { ComponentId: APP } }];
    assert.equal(score(refused).status, 'fail', 'bad ids must be refused before even the app is added');
  }
});

test('packaging partial failures stay failures and read-back exposes only completed writes', () => {
  const failed = packageFixture();
  const call = failed.events.find((entry) => entry.id === 'package');
  call.requests = call.requests.slice(0, 6);
  call.requests.at(-1).response = { status: 403, data: { error: { message: 'Synthetic component failure.' } } };
  call.result = { ok: false, error: 'Add page failed (403); packaging is incomplete.' };
  call.userMessage = call.result.error;
  failed.events.find((entry) => entry.id === 'readback').result.data.value = [
    { objectid: APP, componenttype: 80 }, { objectid: PAGES[0].pageId, componenttype: 10401 },
  ];
  failed.manifest.packaging.attempts[0].outcome = 'failed';
  assert.equal(score(failed).status, 'pass', 'expected handled failure is evidence, not a permanently red fixture');
  call.result.ok = true;
  assert.equal(score(failed).status, 'fail', 'partial package cannot be reported as complete');
  call.result.ok = false;
  call.userMessage = '';
  assert.equal(score(failed).status, 'fail', 'failure must remain visible');
});

test('packaging preflight metadata failures make zero component writes', () => {
  const failed = packageFixture();
  const call = failed.events.find((entry) => entry.id === 'package');
  call.requests = [{ ...call.requests[0], response: { status: 403, data: {} } }];
  call.result = { ok: false, error: 'Cannot resolve the page component type; nothing added.' };
  call.userMessage = call.result.error;
  failed.manifest.packaging.attempts[0] = { event: 'package', outcome: 'failed' };
  assert.equal(score(failed).status, 'pass');
  call.requests.push({ method: 'POST', path: 'AddSolutionComponent', body: { ComponentId: APP }, response: { status: 204 } });
  assert.equal(score(failed).status, 'fail');
});

test('packaging is opt-in and an unapproved or malformed packaging command never borrows success', () => {
  assert.equal(score({ genpagePlan: '', events: [] }).status, 'pass');
  assert.equal(score({ genpagePlan: '## Solution Packaging\nPackage into solution: false\n', events: [] }).status, 'pass');
  const bad = packageFixture();
  bad.genpagePlan = '';
  assert.equal(score(bad).status, 'fail');
  const common = WORKFLOW_ASSERTIONS.get(RULE);
  assert.equal(typeof common, 'function');
  assert.equal(common({ fixture: bad }).status, 'fail');
});

test('packaging allows a caller page order while still requiring app before all pages', () => {
  const fixture = packageFixture();
  const call = fixture.events.find((entry) => entry.id === 'package');
  const reversed = [...PAGES].reverse();
  call.command = call.command.replace(PAGES.map((page) => page.pageId).join(','), reversed.map((page) => page.pageId).join(','));
  call.requests = [...call.requests.slice(0, 4), ...call.requests.slice(4, 7).reverse(), call.requests[7]];
  call.result.added = [call.result.added[0], ...call.result.added.slice(1, 4).reverse(), call.result.added[4]];
  assert.equal(score(fixture).status, 'pass');
  [call.requests[3], call.requests[4]] = [call.requests[4], call.requests[3]];
  assert.equal(score(fixture).status, 'fail');
});

test('packaging read-back permits required dependencies, never a missing direct page', () => {
  const fixture = packageFixture();
  const value = fixture.events.find((entry) => entry.id === 'readback').result.data.value;
  value.push({ objectid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', componenttype: 62 });
  assert.equal(score(fixture).status, 'pass', 'AddRequiredComponents pulls sitemap/files in addition to explicit adds');
  value.splice(value.findIndex((entry) => entry.objectid === PAGES[1].pageId), 1);
  assert.equal(score(fixture).status, 'fail');
});

test('packaging identities cover actual deployed uploads, not just the fixture declared subset', () => {
  const fixture = packageFixture();
  assert.equal(score(fixture).status, 'pass');
  fixture.events.unshift({
    id: 'extra-deploy',
    command: `node genpage-upload.js --app-id ${APP} --code-file extra.tsx --add-to-sitemap`,
    result: { ok: true, appId: APP, pageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
  });
  assert.equal(score(fixture).status, 'fail', 'an undeclared deployed page must not be dropped from packaging');
});

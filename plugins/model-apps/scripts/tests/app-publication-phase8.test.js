'use strict';

// The publish phase (phase 8) publishes the app through its own target list, not through the build's app-publication
// port (lib/app-publication-policy.js), so it reports every app publish it makes to the port: an accepted answer is a
// publish, a failed-by-value answer that may have reached the server and a throw un-prove an exact Main-form list, and
// a WITHHELD / CONFLICT refusal (nothing was published) keeps the earlier proof. An exact list left unproven makes the
// build incomplete: it stops after every phase ran, with the change saved.

const test = require('node:test');
const assert = require('node:assert/strict');

// The engine takes createAppPublication when it loads, so the spy is in place before it is required: it hands the test
// each port the engine makes.
const policy = require('../lib/app-publication-policy.js');
const createAppPublication = policy.createAppPublication;
let onPort = null;
policy.createAppPublication = (...args) => {
  const port = createAppPublication(...args);
  if (onPort) onPort(port);
  return port;
};
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { runSdkBuild: runSdkBuildInPlace } = require('../lib/sdk-build.js');
const { membershipSpec, membershipSdk, APP, FORM_A } = require('./helpers/app-membership-sdk.js');

const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const provenPush = { appMainForms: { mode: 'exact', published: 'matches', tables: [{ table: 'contoso_item', membership: 'exact' }] } };
const PUBLISHED_LAYER = '77777777-0000-4000-8000-000000000077';
const sdkError = (code) => Object.assign(new Error(`publish ${code}`), { code });

// phase8: what the publish phase's app publish does once the server has (or has not) run it. The exact proof is recorded
// just before that publish, standing in for one an earlier push or publish of this run established.
async function build(phase8) {
  const fake = membershipSdk();
  const ports = [];
  const reports = [];
  onPort = (port) => {
    ports.push(port);
    const note = port.noteAppPublication;
    port.noteAppPublication = async (appId, outcome) => {
      const noted = await note(appId, outcome);
      reports.push({ appId, outcome, noted });
      return noted;
    };
  };
  // An accepted publish is proven from the published layer (publishedMainFormsProof): the app names that layer, and the
  // layer offers FORM_A, the one Main form the list allows.
  //   GET /appmodules(<APP>)?$select=appmoduleidunique                              -> { appmoduleidunique: <layer> }
  //   GET /appmodulecomponents?...<layer> and componenttype eq 60                 -> [{ objectid: FORM_A, componenttype: 60 }]
  const get = fake.sdk.dataverse.get;
  fake.sdk.dataverse.get = async (url) => {
    if (url === `/appmodules(${APP})?$select=appmoduleidunique`) return { status: 200, body: { appmoduleidunique: PUBLISHED_LAYER } };
    if (url.startsWith('/appmodulecomponents') && url.includes(PUBLISHED_LAYER) && /componenttype eq 60/.test(url)) {
      return { status: 200, body: { value: [{ objectid: FORM_A, componenttype: 60 }] } };
    }
    return get(url);
  };
  const publishArtifact = fake.sdk.publishArtifact;
  // In this build the app step publishes the app with its own PublishXml, so the one publishArtifact('app') is the
  // publish phase's: publishTargets' app target, after the phase's table PublishXml.
  let appPublishes = 0;
  fake.sdk.publishArtifact = async (kind, id) => {
    if (kind !== 'app') return publishArtifact(kind, id);
    appPublishes += 1;
    ports.at(-1).recordExact(APP, provenPush, { name: 'Membership', mainFormsByTable: { contoso_item: [FORM_A] } });
    return phase8(() => publishArtifact(kind, id), kind, id);
  };
  let result;
  let error;
  try {
    result = await runSdkBuild(membershipSpec(), { sdk: fake.sdk, apply: true, phases: ['app-shell', 'publish'], publish: true });
  } catch (e) {
    error = e;
  } finally {
    onPort = null;
  }
  return { fake, port: ports.at(-1), ports, reports, result, error, appPublishes };
}

const notExact = (port) => port.unsettled().filter((entry) => entry.code === 'APP_MAIN_FORMS_NOT_EXACT');

test('phase 8: an accepted app publish is reported to the port as published', async () => {
  const { port, ports, reports, error, appPublishes } = await build(async (run) => run());
  assert.equal(error, undefined, error && error.stack);
  assert.equal(ports.length, 1, 'the engine makes one port per build');
  assert.equal(appPublishes, 1, 'the publish phase published the app once');
  assert.equal(reports.length, 1, JSON.stringify(reports));
  assert.equal(reports[0].appId, APP);
  assert.equal(reports[0].outcome.answer.publish.kind, 'verified');
  assert.deepEqual(reports[0].noted, { accepted: true });
  assert.deepEqual(port.unsettled(), []);
});

test('phase 8: an app publish failed by value after the server ran it un-proves the exact app, and the build ends incomplete', async () => {
  const { port, reports, error } = await build(async (run, kind, id) => {
    await run();
    return { type: kind, id, shipped: false, publish: { kind: 'failed', error: sdkError('CONNECTION_ERROR') } };
  });
  assert.equal(reports.length, 1, JSON.stringify(reports));
  assert.deepEqual(reports[0].noted, { accepted: false, code: 'CONNECTION_ERROR' });
  assert.equal(notExact(port).length, 1);
  assert.match(notExact(port)[0].reason, /its publish failed \(CONNECTION_ERROR\) and may have reached the server/);
  assert.ok(error, 'an unproven exact list is never a success');
  assert.equal(error.name, 'BuildHalt');
  assert.equal(error.transient, false, 'a re-run of the same attempt cannot prove it: the build does not retry on its own');
  assert.ok((error.incomplete || []).some((entry) => entry.code === 'APP_MAIN_FORMS_NOT_EXACT'), JSON.stringify(error.incomplete));
});

test('phase 8: an app publish that throws after the server ran it un-proves the exact app, and the throw still halts', async () => {
  const { port, reports, error } = await build(async (run) => {
    await run();
    throw sdkError('ECONNRESET');
  });
  assert.ok(error, 'the build still fails');
  assert.equal(reports.length, 1, JSON.stringify(reports));
  assert.equal(reports[0].outcome.error.code, 'ECONNRESET');
  assert.deepEqual(reports[0].noted, { accepted: false, code: 'ECONNRESET' });
  assert.equal(notExact(port).length, 1);
});

for (const code of ['APP_MAIN_FORM_PUBLISH_WITHHELD', 'APP_MAIN_FORM_PUBLISH_CONFLICT']) {
  test(`phase 8: a ${code} refusal (nothing was published) keeps the earlier proof`, async () => {
    const { port, reports, error } = await build(async (_run, kind, id) => ({ type: kind, id, shipped: false, publish: { kind: 'failed', error: sdkError(code) } }));
    assert.equal(error, undefined, error && error.stack);
    assert.equal(reports.length, 1, JSON.stringify(reports));
    assert.deepEqual(reports[0].noted, { accepted: false, code });
    assert.deepEqual(notExact(port), []);
  });
}

test('phase 8: a build that asks for no exact list reports to the port and ends as before', async () => {
  const fake = membershipSdk();
  const ports = [];
  onPort = (port) => ports.push(port);
  try {
    const result = await runSdkBuild(membershipSpec(), { sdk: fake.sdk, apply: true, phases: ['app-shell', 'publish'], publish: true });
    assert.equal(result.ok, true);
    assert.equal(result.incomplete, undefined);
  } finally {
    onPort = null;
  }
  assert.equal(ports.length, 1);
  assert.deepEqual(ports[0].unsettled(), []);
});

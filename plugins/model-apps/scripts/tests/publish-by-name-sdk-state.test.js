'use strict';
// The pre-app publish (publishTablesBeforeApp, sdk-build.js) names tables to Dataverse itself, so the SDK does not make it and does not
// re-baseline its workspace copies of the views and forms the request publishes: a publish moves a row's version token, and the SDK
// adopts the new one only for a publish of its own. The build relies on nothing pushing one of those copies again in the same run, and on
// the next run fetching each copy before it edits it. These tests prove that against the REAL vendored SDK and a fake whose publish moves
// the token (`publishBumpsVersion`): a build whose tables were published by name is followed by a build that pushes the same view, which
// the platform would refuse as stale if the copy still held the old token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { createFakeDataverse } = require('./helpers/fake-dataverse.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ORIGIN = 'https://contoso.crm.dynamics.com';
const ENTITIES = {
  new_ticket: { attributes: { new_name: 'String', new_code: 'String', new_area: 'String', new_extra: 'String' } },
  new_task: { attributes: { new_name: 'String', new_due: 'String' } },
};
const PHASES = ['views', 'charts', 'forms', 'publish'];

function specFor(viewColumns) {
  const table = (schemaName, displayName, pluralName, columns) => ({ schemaName, displayName, pluralName, existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns });
  return {
    $schemaVersion: '1.0',
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', uniqueName: 'new_supportdesk' },
    entities: [
      table('new_ticket', 'Ticket', 'Tickets', ['new_code', 'new_area', 'new_extra'].map((c) => ({ schemaName: c, displayName: c, type: 'Text' }))),
      table('new_task', 'Task', 'Tasks', [{ schemaName: 'new_due', displayName: 'Due', type: 'Text' }]),
    ],
    views: [{ entity: 'new_ticket', name: 'Open Tickets', columns: viewColumns }, { entity: 'new_task', name: 'My Tasks', columns: ['new_name', 'new_due'] }],
    forms: [{ entity: 'new_ticket', name: 'Ticket', layout: 'auto' }, { entity: 'new_task', name: 'Task', layout: 'auto' }],
  };
}

function scenario() {
  const fake = createFakeDataverse({ entities: ENTITIES, publishBumpsVersion: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-by-name-'));
  dirs.push(dir);
  // Each build gets a FRESH SDK over the same workspace directory, as every CLI run does.
  const sdkOver = async () => {
    const real = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: fake.httpClient });
    await real.initWorkspace();
    return real;
  };
  async function build(spec, sdk) {
    const mark = fake.mark();
    const result = await runSdkBuild(spec, { sdk: sdk || await sdkOver(), apply: true, publish: true, phases: PHASES, warn: () => {} });
    return { result, writes: fake.writeCounts(mark) };
  }
  // The pre-app publish: the tables are named to the platform just before phase 8's SDK publish, so the SDK's copies are held across it.
  const publishedByName = (sdk) => new Proxy(sdk, {
    get: (target, key) => {
      if (key === 'publishArtifacts') {
        return async (...args) => {
          const response = await fake.httpClient.post(`${ORIGIN}/api/data/v9.0/PublishXml`, { ParameterXml: '<importexportxml><entities><entity>new_ticket</entity><entity>new_task</entity></entities></importexportxml>' });
          assert.ok(response.status < 300, 'the fake accepted the publish');
          return target.publishArtifacts(...args);
        };
      }
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
    },
  });
  return { fake, sdkOver, build, publishedByName };
}

const COLUMNS = ['new_name', 'new_code'];

test('a build whose tables were published by name is followed by a build that can push the same view', async () => {
  const s = scenario();
  await s.build(specFor(COLUMNS));
  const second = await s.build(specFor([...COLUMNS, 'new_area']), s.publishedByName(await s.sdkOver()));
  assert.strictEqual(second.writes['PATCH savedqueries'], 1, JSON.stringify(second.writes));
  assert.deepStrictEqual(s.fake.unpublished(), [], 'the build published what it saved');
  assert.ok(s.fake.publishes.filter((table) => table === 'new_ticket').length >= 2, 'the tables were published by name, then by the SDK');

  // The token the platform holds is not the one the SDK saved with its push: a push built on the copy it kept would be refused (412).
  const third = await s.build(specFor([...COLUMNS, 'new_area', 'new_extra']));
  assert.strictEqual(third.writes['PATCH savedqueries'], 1, JSON.stringify(third.writes));
  assert.match(s.fake.rows('savedqueries').find((r) => r.data.name === 'Open Tickets').data.layoutxml, /new_extra/, 'the new column reached the view');
  assert.deepStrictEqual(s.fake.unpublished(), []);
});

test('and an unchanged build after it writes nothing but its publish', async () => {
  const s = scenario();
  await s.build(specFor(COLUMNS));
  await s.build(specFor([...COLUMNS, 'new_area']), s.publishedByName(await s.sdkOver()));
  const again = await s.build(specFor([...COLUMNS, 'new_area']));
  assert.deepStrictEqual(again.writes, { 'POST PublishXml': 1 }, JSON.stringify(again.writes));
  assert.deepStrictEqual(s.fake.unpublished(), []);
});

test('control: the same two builds with no publish by name behave the same way', async () => {
  const s = scenario();
  await s.build(specFor(COLUMNS));
  const second = await s.build(specFor([...COLUMNS, 'new_area']));
  assert.strictEqual(second.writes['PATCH savedqueries'], 1);
  const third = await s.build(specFor([...COLUMNS, 'new_area', 'new_extra']));
  assert.strictEqual(third.writes['PATCH savedqueries'], 1);
  assert.deepStrictEqual(s.fake.unpublished(), []);
});

// What the tests above would be worth if the copy were never stale: here it is shown to be. A copy edited, then held across a publish the SDK
// did not make, is refused when it is pushed; the builds above are not, because the reconcile fetches each copy before it edits it.
test('premise: a copy held across a publish by name is stale, and a push built on it is refused', async () => {
  const s = scenario();
  await s.build(specFor(COLUMNS));
  const sdk = await s.sdkOver();
  const id = s.fake.rows('savedqueries').find((r) => r.data.name === 'Open Tickets').data.savedqueryid;
  await sdk.fetchArtifact('view', id);
  const current = await sdk.getArtifact('view', id);
  await sdk.updateElement('view', id, '/columns', [...current.columns, { name: 'new_area', width: 100, order: current.columns.length }]);
  await s.fake.httpClient.post(`${ORIGIN}/api/data/v9.0/PublishXml`, { ParameterXml: '<importexportxml><entities><entity>new_ticket</entity></entities></importexportxml>' });
  const outcome = await sdk.pushArtifact('view', id).then((result) => result, (error) => error);
  assert.ok(outcome instanceof Error || outcome.saved === false, `the push was refused: ${JSON.stringify(outcome && outcome.saved)}`);
});

'use strict';
// The build harness of the commandStates tests (command-state-build.test.js, command-state-taint.test.js): the build's own entry point
// (lib/sdk-build.js runSdkBuild) over the light mock SDK (helpers/mock-sdk.js), whose raw client publishes the tables before the app, and the
// command rows of the fake org (helpers/command-state-org.js) reached through the real raw client (createAzHttpClient) and the feature's own
// transport, so the retry and send-once behaviour under test is the shipped one.

const assert = require('node:assert');
const { inOwnFolder } = require('./own-app-folder.js');
const runSdkBuild = inOwnFolder(require('../../lib/sdk-build.js').runSdkBuild);
const { makeSimpleMockSdk } = require('./mock-sdk.js');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');
const { createCommandStateTransport, commandStateSendOnce } = require('../../lib/command-state-transport.js');
const { createCommandStateOrg, commandRow, ORIGIN } = require('./command-state-org.js');
const { validateAppSpec } = require('../../lib/app-spec.js');

const T = 'new_ticket';
const MD = '44444444-4444-4444-8444-444444444444';
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const API = `${ORIGIN}/api/data/v9.2`;
const HIDE = { entity: T, location: 'MainTab', scope: 'table', rowId: ROW, hidden: true };
const APPLY = { apply: true, publish: true };

function specFor(states = [HIDE], extra = {}) {
  const spec = {
    minimumPluginVersion: '2.24.0',
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support', uniqueName: 'contoso_Support' },
    entities: [{ schemaName: T, displayName: 'Ticket', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: T, title: 'Tickets' }] }] }] },
    ...(states ? { commandStates: states } : {}),
    ...extra,
  };
  assert.deepStrictEqual(validateAppSpec(spec).errors, [], 'the fixture is a valid spec');
  return spec;
}

// The tables a PublishXml body names: { "ParameterXml": "<importexportxml><entities><entity>new_ticket</entity></entities></importexportxml>" }
const tablesOf = (body) => [...String((body && body.ParameterXml) || '').matchAll(/<entity>([^<]+)<\/entity>/g)].map((m) => m[1]);

function harness({ rows = [commandRow(ROW, T, MD)], publishStatus = 204, onPublish, ...orgOptions } = {}) {
  const org = createCommandStateOrg({ writable: true, tables: { [T]: { metadataId: MD } }, rows, ...orgOptions });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {}, sendOnce: commandStateSendOnce });
  const transport = createCommandStateTransport({ client, apiUrl: (p) => `${API}${p}` });
  const published = [];
  const mockSdk = () => {
    const { sdk, calls } = makeSimpleMockSdk();
    sdk.dataverse = {
      apiUrl: (p) => `${API}${p}`,
      post: async (url, body) => { published.push(tablesOf(body)); if (onPublish) onPublish(tablesOf(body)); return { status: publishStatus, body: null }; },
    };
    return { sdk, calls };
  };
  const build = async (spec, opts = {}) => {
    const { sdk, calls } = mockSdk();
    const warnings = [];
    const run = { sdk, env: ORIGIN, commandStateTransport: transport, emit: () => {}, warn: (w) => warnings.push(String(w)), ...opts };
    try {
      return { res: await runSdkBuild(spec, run), calls, warnings };
    } catch (error) {
      return { error, calls, warnings };
    }
  };
  // The approvals a dry run prints, exactly as an author would pass them back.
  const approve = async (spec) => {
    const { res, error } = await build(spec, { apply: false });
    assert.ifError(error);
    const plan = res.commandStatePlan;
    return { plan, approvals: { rows: new Set(plan.rows.map((r) => r.approval).filter(Boolean)), tables: new Set(plan.tables.map((t) => t.token)) } };
  };
  const patches = () => org.requests.filter((r) => r.method === 'PATCH');
  return { org, build, approve, published, patches, transport, mockSdk };
}

// The build's own entry (build-model-app.js buildModelApp) with its durable journal, for what a halt leaves on disk and says on the console.
async function buildWithJournal(h, spec, approvals) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { buildModelApp } = require('../../build-model-app.js');
  const { openJournal } = require('../../lib/build-journal.js');
  const { makeTempDir } = require('./temp-dirs.js');
  const engine = require('../../lib/sdk-build.js').runSdkBuild;
  const workspaceDir = makeTempDir('cs-journal-');
  const journal = openJournal(path.join(workspaceDir, 'logs'));
  const said = [];
  const logged = [];
  let result;
  const { sdk } = h.mockSdk();
  let caught;
  try {
    result = await buildModelApp(spec, { apply: true, publish: true, env: ORIGIN, workspaceDir, commandStateApprovals: approvals }, {
      sdk, journal, log: (m) => logged.push(String(m)), warn: (m) => said.push(String(m)), sleep: async () => {},
      runBuild: (s, o) => engine(s, { ...o, commandStateTransport: h.transport }),
    });
  } catch (error) {
    caught = error;
  }
  return { caught, result, said: said.join('\n'), logged: logged.join('\n'), log: fs.readFileSync(journal.path, 'utf8'), status: fs.readFileSync(journal.statusPath, 'utf8') };
}

module.exports = { T, MD, ROW, API, HIDE, APPLY, specFor, tablesOf, harness, buildWithJournal };

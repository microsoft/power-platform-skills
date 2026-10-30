'use strict';

// app.theme against the REAL vendored SDK (setAppTheme / getAppTheme) and a stateful fake of what it reads and writes
// (helpers/app-theme-server.js), layered on the app-membership fake so the SAME SDK instance also holds the app's exact
// Main-form obligation. These pin the request budget at the wire: a set publishes its new version web resource and
// nothing else; the app is published once, through the publication port, and not at all while an exact obligation
// withholds it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planAppTheme, applyAppTheme, verifyAppTheme } = require('../lib/app-theme.js');
const { createAppPublication } = require('../lib/app-publication-policy.js');
const { applyAppMainForms } = require('../lib/app-components.js');
const { APP, FORM_A, FORM_B, META } = require('./helpers/app-membership-sdk.js');
const { SITEMAP } = require('./helpers/app-pin-server.js');
const { appThemeServer, SENTINEL } = require('./helpers/app-theme-server.js');

const THEME = { basePaletteColor: '#0F6CBD', appHeader: { background: '#112233', foreground: '#FFFFFF' } };
const ENVIRONMENT_THEME = 'contoso_/environment-theme.xml';
const spec = (theme) => ({ app: { theme } });
const appPublishes = (server) => server.writes().filter((line) => /<appmodule>/.test(line) || /^BATCH .*PublishXml/.test(line));
const publishXml = (server) => server.writes().filter((line) => line.startsWith('POST /PublishXml'));

// The build's create port as B1 answers it: { outcome, result }, a throw from the setter being an unknown outcome.
function createsPort() {
  const port = {
    runs: [],
    async run(descriptor, execute) {
      port.runs.push(descriptor);
      try {
        return { outcome: 'created', result: await execute() };
      } catch (error) {
        // The SDK reports a lost answer as CONNECTION_ERROR: the write may or may not have landed.
        if (error && error.code === 'CONNECTION_ERROR') return { outcome: 'unknown', code: 'CREATE_OUTCOME_UNKNOWN', result: undefined };
        throw error;
      }
    },
  };
  return port;
}

async function build(t, options = {}) {
  const server = appThemeServer(t, options);
  await server.sdk.initWorkspace();
  await server.sdk.fetchArtifact('app', APP);
  const appWrite = { publish: (id) => server.sdk.publishArtifact('app', id) };
  const publication = createAppPublication({ appWrite, client: server.sdk.dataverse });
  const creates = createsPort();
  const ctx = { sdk: server.sdk, appId: APP, publication, creates };
  const run = async (theme) => applyAppTheme(await planAppTheme(spec(theme), ctx), ctx);
  return { ...server, ctx, publication, creates, run };
}

test('REAL BUNDLE: a first set publishes its new version web resource only; the app is published once, by the port', async (t) => {
  const server = await build(t);
  const result = await server.run(THEME);
  assert.deepEqual(result.saved, ['app.theme']);
  assert.deepEqual(result.pendingPublish, ['app.theme']);
  assert.equal(result.managedBindings.length, 1);
  assert.equal(server.creates.runs.length, 1, 'the set went through the create port');
  const written = server.writes();
  assert.match(written[0], /^POST \/webresourceset \{"name":"contoso_\/apptheme\/[0-9a-f]{16}\.xml"/);
  assert.equal(publishXml(server).length, 1, written.join('\n'));
  assert.match(publishXml(server)[0], /<webresources><webresource>[0-9a-f-]{36}<\/webresource><\/webresources>/);
  assert.ok(written.some((line) => line.startsWith('POST /appsettings ')), 'the row is created as a draft');
  assert.deepEqual(appPublishes(server), [], 'the theme publishes no app');
  assert.equal((await verifyAppTheme(spec(THEME), server.ctx))[0].state, 'pendingPublish');

  assert.deepEqual(await server.publication.flush(), { published: [APP], withheld: [], failed: [] });
  assert.equal(appPublishes(server).length, 1);
  assert.deepEqual(await verifyAppTheme(spec(THEME), server.ctx), [{ key: 'app.theme', ok: true, state: 'live' }]);

  const before = server.writes().length;
  const again = await server.run({ ...THEME, basePaletteColor: '#0f6cbd' });
  assert.deepEqual(again.unchanged, ['app.theme']);
  assert.equal(server.writes().length, before, 'an equal theme sends nothing');
  assert.deepEqual(server.publication.owed(), []);
});

test('REAL BUNDLE: null removes the app\'s row (its DELETE only) and the environment theme applies after the app publish', async (t) => {
  const server = await build(t, { environmentTheme: ENVIRONMENT_THEME });
  await server.run(THEME);
  await server.publication.flush();
  const before = server.writes().length;
  const result = await server.run(null);
  assert.deepEqual(result.saved, ['app.theme']);
  const sent = server.writes().slice(before);
  assert.equal(sent.length, 1, sent.join('\n'));
  assert.match(sent[0], /^DELETE \/appsettings\([0-9a-f-]{36}\)$/);
  assert.equal((await verifyAppTheme(spec(null), server.ctx))[0].state, 'pendingPublish');
  assert.deepEqual(await server.publication.flush(), { published: [APP], withheld: [], failed: [] });
  assert.equal(server.themeRow(), undefined);
  assert.deepEqual(await verifyAppTheme(spec(null), server.ctx), [{ key: 'app.theme', ok: true, state: 'live' }]);
  assert.equal((await server.sdk.getAppTheme(APP)).resolved.webResourceName, ENVIRONMENT_THEME);
});

test('REAL BUNDLE: null removes a published "no theme" sentinel row, which otherwise keeps the environment theme from applying', async (t) => {
  const server = await build(t, { environmentTheme: ENVIRONMENT_THEME, row: { published: SENTINEL } });
  const info = await server.sdk.getAppTheme(APP);
  assert.equal(info.row.state, 'published');
  assert.equal(info.resolved.source, 'none', 'the sentinel resolves to no theme at all');
  assert.equal((await verifyAppTheme(spec(null), server.ctx))[0].ok, false, 'not removed yet');
  const result = await server.run(null);
  assert.deepEqual(result.saved, ['app.theme']);
  assert.deepEqual(server.writes().filter((line) => line.startsWith('DELETE ')).length, 1);
  await server.publication.flush();
  assert.equal((await server.sdk.getAppTheme(APP)).resolved.webResourceName, ENVIRONMENT_THEME);
  assert.deepEqual(await verifyAppTheme(spec(null), server.ctx), [{ key: 'app.theme', ok: true, state: 'live' }]);
});

test('REAL BUNDLE: without the build\'s create port a set writes nothing', async (t) => {
  const server = await build(t);
  delete server.ctx.creates;
  const result = await server.run(THEME);
  assert.deepEqual(result.refused, [{ key: 'app.theme', code: 'APP_THEME_CREATE_PORT_UNAVAILABLE' }]);
  assert.deepEqual(server.writes(), []);
  assert.deepEqual(server.publication.owed(), []);
});

test('REAL BUNDLE: a set that fails after its version was created is unknown and queues nothing; the re-run reuses the version and writes only the row', async (t) => {
  const server = await build(t);
  server.failNext('POST /appsettings', 500);
  const failed = await server.run(THEME);
  assert.equal(failed.unknown.length, 1, JSON.stringify(failed));
  assert.deepEqual(failed.saved, []);
  assert.deepEqual(server.publication.owed(), []);
  assert.equal(server.writes().filter((line) => line.startsWith('POST /webresourceset')).length, 1);
  const mark = server.writes().length;
  const rerun = await server.run(THEME);
  assert.deepEqual(rerun.saved, ['app.theme']);
  assert.deepEqual(rerun.managedBindings, [], 'the reused version is not a new create');
  const sent = server.writes().slice(mark);
  assert.ok(!sent.some((line) => line.startsWith('POST /webresourceset') || line.startsWith('POST /PublishXml')), sent.join('\n'));
  assert.ok(sent.some((line) => line.startsWith('POST /appsettings ')));
});

test('REAL BUNDLE: a lost answer to the row write is an unknown create; the re-run finds the saved draft and only queues its publication', async (t) => {
  const server = await build(t);
  server.failNext('POST /appsettings', 'afterCommit');
  const lost = await server.run(THEME);
  assert.deepEqual(lost.unknown, [{ key: 'app.theme', code: 'CREATE_OUTCOME_UNKNOWN' }]);
  assert.deepEqual(server.publication.owed(), []);
  const mark = server.writes().length;
  const rerun = await server.run(THEME);
  assert.deepEqual(rerun.unchanged, ['app.theme']);
  assert.deepEqual(server.writes().slice(mark), [], 'nothing is re-sent');
  assert.deepEqual(server.publication.owed().map((entry) => entry.id), [APP]);
});

test('REAL BUNDLE: a theme cannot publish an app whose exact Main-form membership was edited after its push: withheld, zero app publish requests', async (t) => {
  const server = await build(t, { pin: { members: [`1:${META.contoso_item}`, `62:${SITEMAP}`, `60:${FORM_B}`] } });
  await applyAppMainForms(server.sdk, APP, { contoso_item: [FORM_A] }, { mainFormsOnUpdate: 'exact' });
  const pushed = await server.sdk.pushArtifact('app', APP);
  assert.equal(pushed.saved, true);
  server.publication.recordExact(APP, pushed, { name: 'Membership', mainFormsByTable: { contoso_item: [FORM_A] } });
  // Another writer puts the removed Main form back before the app is published.
  server.state.members.add(`60:${FORM_B}`);
  const result = await server.run(THEME);
  assert.deepEqual(result.pendingPublish, ['app.theme']);
  assert.equal(publishXml(server).length, 1, 'the version web resource alone');
  assert.throws(() => server.publication.assertRawPublishAllowed(APP), { code: 'APP_PUBLISH_BYPASS_REFUSED' });
  const out = await server.publication.flush();
  assert.deepEqual(out, { published: [], withheld: [{ id: APP, code: 'APP_MAIN_FORM_PUBLISH_WITHHELD' }], failed: [] });
  assert.deepEqual(appPublishes(server), [], 'no app publish request was sent');
  assert.equal(server.publication.owed().length, 1, 'the theme stays owed');
  assert.equal(server.publication.unsettled()[0].code, 'APP_MAIN_FORMS_NOT_EXACT');
});

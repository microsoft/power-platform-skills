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

// A create port with B1's DURABLE shape, for the theme's composite create: the intent is written to a journal BEFORE the
// setter runs and the receipt after it answers. The journal is plain JSON text, so a restart is a new port over the same
// text (and a receipt that does not survive JSON is caught). An intent whose answer was never recorded stays pending and
// is admitted again only as unknown — or, with `recover` (B1 resolved it as made), as adopted — and its setter never runs
// twice. A throw from the setter is an unknown outcome: the write may have landed.
function durableCreatesPort(journal, { recover = false } = {}) {
  const load = () => JSON.parse(journal.text || '[]');
  const save = (rows) => { journal.text = JSON.stringify(rows); };
  const keyOf = (descriptor) => JSON.stringify([descriptor.kind, descriptor.identity]);
  const port = {
    executed: 0,
    entries: load,
    async run(descriptor, execute) {
      const key = keyOf(descriptor);
      const rows = load();
      const pending = rows.find((row) => row.key === key && row.state === 'pending');
      if (pending) {
        if (!recover) return { outcome: 'unknown', code: 'CREATE_PENDING_UNKNOWN', result: undefined };
        pending.state = 'adopted';
        save(rows);
        return { outcome: 'adopted', result: undefined };
      }
      save([...rows, { key, state: 'pending', serverAssigned: descriptor.serverAssigned === true, childKeys: descriptor.childKeys }]);
      port.executed += 1;
      let written;
      try {
        written = await execute();
      } catch {
        return { outcome: 'unknown', code: 'CREATE_OUTCOME_UNKNOWN', result: undefined };
      }
      const after = load();
      Object.assign(after.find((row) => row.key === key && row.state === 'pending'), { state: 'created', receipt: descriptor.receipt(written) });
      save(after);
      return { outcome: 'created', result: written };
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
  const version = server.theme.webResources.find((resource) => /\/apptheme\//.test(resource.name));
  assert.deepEqual(result.managedBindings, [
    { kind: 'webResource', key: 'app.theme', id: version.id, origin: 'created' },
    { kind: 'appSetting', key: 'app.theme', id: server.themeRow().id, origin: 'created' },
  ], 'both records the set created, by their real ids');
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
  assert.deepEqual(rerun.managedBindings, [{ kind: 'appSetting', key: 'app.theme', id: server.themeRow().id, origin: 'created' }], 'the reused version is not a new create; the row is');
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

const versionOf = (server) => server.theme.webResources.find((resource) => /\/apptheme\//.test(resource.name));
const durable = (server, journal, options) => { server.ctx.creates = durableCreatesPort(journal, options); return server.ctx.creates; };

test('REAL BUNDLE (durable create port): a first set\'s receipt names the setting row and the version it created, by their real ids', async (t) => {
  const server = await build(t);
  const journal = { text: '' };
  const port = durable(server, journal);
  const result = await server.run(THEME);
  assert.deepEqual(result.saved, ['app.theme']);
  const row = server.themeRow().id;
  const version = versionOf(server);
  assert.notEqual(row, version.id);
  assert.deepEqual(port.entries().map(({ state, receipt }) => ({ state, receipt })), [{
    state: 'created',
    receipt: { id: row, childIds: { webResource: version.id, appSetting: row }, reused: {}, versionName: version.name },
  }]);
  const reads = server.theme.requests.filter((line) => line.startsWith('GET /settingdefinitions?$select=settingdefinitionid,uniquename&') || line.startsWith('GET /appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=appsettingid,value,componentstate&'));
  assert.equal(reads.length, 2, 'the row id is read back once: its definition, then the row');
});

test('REAL BUNDLE (durable create port): a set that reuses an existing version owns only the row it created; the version is listed as reused', async (t) => {
  const server = await build(t);
  // The version exists already (an earlier theme of the same bytes) and the app has no row: set, then remove the draft.
  await server.sdk.setAppTheme(APP, THEME, { publish: false });
  await server.sdk.setAppTheme(APP, null, { publish: false });
  assert.equal(server.themeRow(), undefined);
  const version = versionOf(server);
  const port = durable(server, { text: '' });
  const mark = server.writes().length;
  const result = await server.run(THEME);
  assert.deepEqual(result.saved, ['app.theme']);
  assert.ok(!server.writes().slice(mark).some((line) => line.startsWith('POST /webresourceset')), 'the version is reused');
  const row = server.themeRow().id;
  assert.deepEqual(port.entries()[0].receipt, { id: row, childIds: { appSetting: row }, reused: { webResource: version.id }, versionName: version.name });
  assert.deepEqual(result.managedBindings, [{ kind: 'appSetting', key: 'app.theme', id: row, origin: 'created' }]);
});

test('REAL BUNDLE (durable create port): a set that fails after creating its version stays pending; a restart answers unknown or, recovered, not saved; the next set owns only its row', async (t) => {
  const server = await build(t);
  const journal = { text: '' };
  durable(server, journal);
  server.failNext('POST /appsettings', 500);
  const failed = await server.run(THEME);
  assert.deepEqual(failed.unknown, [{ key: 'app.theme', code: 'CREATE_OUTCOME_UNKNOWN' }]);
  assert.deepEqual(JSON.parse(journal.text).map((row) => row.state), ['pending']);
  const version = versionOf(server);
  assert.ok(version, 'the version was created before the row write failed');

  const mark = server.writes().length;
  const restarted = durable(server, journal);
  assert.deepEqual((await server.run(THEME)).unknown, [{ key: 'app.theme', code: 'CREATE_PENDING_UNKNOWN' }]);
  const recovered = durable(server, journal, { recover: true });
  const notSaved = await server.run(THEME);
  assert.deepEqual(notSaved.unknown, [{ key: 'app.theme', code: 'APP_THEME_NOT_SAVED' }], 'adopted, but the app will not show the theme');
  assert.equal(restarted.executed + recovered.executed, 0, 'the setter never ran again for the pending intent');
  assert.deepEqual(server.writes().slice(mark), [], 'zero writes after the restart');
  assert.deepEqual(server.publication.owed(), []);

  const next = durable(server, journal);
  const saved = await server.run(THEME);
  assert.deepEqual(saved.saved, ['app.theme']);
  const row = server.themeRow().id;
  assert.deepEqual(next.entries().at(-1).receipt, { id: row, childIds: { appSetting: row }, reused: { webResource: version.id }, versionName: version.name });
});

test('REAL BUNDLE (durable create port): a lost answer to the row write stays pending; the restart finds the saved draft, re-sends nothing and only queues its publication', async (t) => {
  const server = await build(t);
  const journal = { text: '' };
  durable(server, journal);
  server.failNext('POST /appsettings', 'afterCommit');
  assert.deepEqual((await server.run(THEME)).unknown, [{ key: 'app.theme', code: 'CREATE_OUTCOME_UNKNOWN' }]);
  assert.ok(server.themeRow(), 'the row write landed');
  assert.deepEqual(server.publication.owed(), []);
  const mark = server.writes().length;
  const restarted = durable(server, journal);
  const again = await server.run(THEME);
  assert.deepEqual(again.unchanged, ['app.theme']);
  assert.deepEqual(again.unknown, []);
  assert.deepEqual(again.managedBindings, [], 'nothing is receipted for a create this run did not make');
  assert.deepEqual(server.publication.owed().map((entry) => entry.id), [APP]);
  assert.equal(restarted.executed, 0, 'the setter did not run again');
  assert.deepEqual(JSON.parse(journal.text).map((row) => row.state), ['pending'], 'the intent is left for the port\'s own recovery');
  assert.deepEqual(server.writes().slice(mark), [], 'nothing is re-sent');
});

test('REAL BUNDLE: a set whose created row cannot be read back as its own is unknown, never a receipt naming another record', async (t) => {
  for (const mode of ['unreadable', 'replaced']) {
    const server = await build(t);
    const setAppTheme = server.sdk.setAppTheme.bind(server.sdk);
    server.sdk.setAppTheme = async (...args) => {
      const written = await setAppTheme(...args);
      if (mode === 'unreadable') server.failNext('GET /settingdefinitions', 503);
      else server.themeRow().draft = 'contoso_/apptheme/ffffffffffffffff.xml';
      return written;
    };
    const result = await server.run(THEME);
    assert.deepEqual(result.unknown, [{ key: 'app.theme', code: 'APP_THEME_RECEIPT_UNREADABLE' }], mode);
    assert.deepEqual(result.saved, [], mode);
    assert.deepEqual(result.managedBindings, [], mode);
    assert.deepEqual(server.publication.owed(), [], mode);
  }
});

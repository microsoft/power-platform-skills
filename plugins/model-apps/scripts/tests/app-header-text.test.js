'use strict';
// lib/app-header-text.js: the app header's texts held to being plain text, at the HTTP client the bundled SDK is given.
//
// The SDK's push of an app writes the header — `{ name, description }`, from the workspace copy — when its own comparison read of the header finds a difference, and
// also when that read cannot be made. The build never edits a header text that is not plain, but it cannot stop the SDK from writing the copy it holds; the client can.
// These tests pin the guard itself: what it refuses, what it must leave alone, and how it is wired into every SDK the plugin makes. The same refusal over the real bundle,
// for each way the comparison read can fail, is in app-header-text-real-bundle.test.js.
const test = require('node:test');
const assert = require('node:assert');
const { guardAppHeaderWrites, nonPlainHeaderTexts, describeHeldAppText, APP_HEADER_NOT_PLAIN_TEXT } = require('../lib/app-header-text.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');

const API = 'https://contoso.crm.dynamics.com/api/data/v9.0';
const APP = '11111111-2222-3333-4444-555555555555';
// The request the SDK makes: the full URL, with the `?$select=` the write echoes back.
const ROW = `${API}/appmodules(${APP})?$select=appmoduleid`;
const OPTIONS = { headers: { 'If-Match': 'W/"1"' } };
const localized = { 1033: 'Probe', 1036: 'Sonde' };

// A client that records what it is asked and answers like the plugin's: { status, headers, body }.
function recordingClient() {
  const calls = [];
  const answer = { status: 204, headers: {}, body: {} };
  const client = {};
  for (const verb of ['get', 'post', 'patch', 'put', 'delete']) client[verb] = async (...args) => { calls.push({ verb, args }); return answer; };
  return { client, calls, answer };
}

// --- what is refused ---------------------------------------------------------------------------------------------------------------------------------------

// Every value a String column cannot take, and that a header text could arrive as: an LCID map (a text per language), a list, a number, a boolean, nothing at all, an empty object.
const NOT_TEXT = [['a text per language', localized], ['a list', ['Probe']], ['a number', 7], ['a boolean', true], ['null', null], ['an empty object', {}]];

for (const key of ['name', 'description']) {
  for (const [what, value] of NOT_TEXT) {
    test(`a PATCH of an app module row whose ${key} is ${what} is refused before the client is asked, with a typed error nothing re-runs on its own`, async () => {
      const { client, calls } = recordingClient();
      const errors = [];
      const guarded = guardAppHeaderWrites(client, (code, message) => { const e = Object.assign(new Error(message), { code }); errors.push(e); return e; });
      const body = { name: 'Probe', description: 'Tickets', [key]: value };
      await assert.rejects(guarded.patch(ROW, body, OPTIONS), (e) => {
        assert.strictEqual(e, errors[0], 'the error the factory made');
        assert.strictEqual(e.code, APP_HEADER_NOT_PLAIN_TEXT);
        assert.strictEqual(e.transient, false, 'the build\'s own re-run of a halt it takes for transient reads this marker on the error');
        assert.match(e.message, new RegExp(`^Refused before anything was sent: the write of app ${APP}'s header would have carried a text that is not plain — the app's ${key} (is localized|could not be read as plain text)`));
        assert.match(e.message, /Nothing was sent, so the app is as it was, and the push stopped before it wrote the app's navigation\./);
        assert.match(e.message, /Run it again: a re-run normally succeeds\./);
        return true;
      });
      assert.deepStrictEqual(calls, [], 'no request, so no token either');
    });
  }
}

test('both texts at once, and a routing description beside them, are named together — the routing description is not judged', async () => {
  const { client, calls } = recordingClient();
  const guarded = guardAppHeaderWrites(client);
  await assert.rejects(guarded.patch(ROW, { name: localized, description: ['Tickets'], aiappdescription: 'Route tickets here.' }),
    (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT && /the app's name is localized \(2 languages: 1033, 1036\) and its description could not be read as plain text \(it came back as a list\)\./.test(e.message));
  assert.deepStrictEqual(calls, []);
  // Whatever the routing description is, it does not stop a write of two plain texts.
  await guarded.patch(ROW, { name: 'Probe', description: 'Tickets', aiappdescription: 'Route tickets here.' });
  assert.strictEqual(calls.length, 1);
});

test('a body that is JSON text is judged as the object it carries', async () => {
  const { client, calls } = recordingClient();
  const guarded = guardAppHeaderWrites(client);
  await assert.rejects(guarded.patch(ROW, JSON.stringify({ name: localized })), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
  await assert.rejects(guarded.patch(ROW, '{"description":7}'), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
  assert.deepStrictEqual(calls, []);
  for (const fine of ['{"name":"Probe","description":"Tickets"}', '{"aiappdescription":"x"}', '[]', 'null', 'not json at all', '']) await guarded.patch(ROW, fine);
  assert.strictEqual(calls.length, 6, 'text that is not an object with a bad header text is not this guard\'s to refuse');
});

// --- what is passed on, untouched --------------------------------------------------------------------------------------------------------------------------

test('plain text goes through exactly as it was — the same arguments, the client\'s own answer — including the empty string and a key that is absent', async () => {
  const { client, calls, answer } = recordingClient();
  const guarded = guardAppHeaderWrites(client);
  const bodies = [
    { name: 'Help Desk', description: 'Track tickets' },
    { name: 'Help Desk', description: '' },
    { description: 'Only the description' },
    { name: 'Only the name' },
    { name: 'Help Desk', description: 'Track tickets', aiappdescription: 'Route tickets here.' },
    { aiappdescription: 'Route tickets here.' },
    { name: 'Help Desk', description: undefined },
    {},
  ];
  for (const body of bodies) {
    const before = calls.length;
    assert.strictEqual(await guarded.patch(ROW, body, OPTIONS), answer, 'the client\'s own answer');
    assert.strictEqual(calls.length, before + 1);
    assert.strictEqual(calls.at(-1).args[0], ROW);
    assert.strictEqual(calls.at(-1).args[1], body, 'the very object, not a copy');
    assert.strictEqual(calls.at(-1).args[2], OPTIONS);
  }
  // Without options, as the SDK sometimes calls it.
  await guarded.patch(ROW, { name: 'x' });
  assert.deepStrictEqual(calls.at(-1).args, [ROW, { name: 'x' }, undefined]);
});

test('only the app module ROW is judged: other tables, a sub-resource, other verbs and a read are the client\'s, whatever their bodies hold', async () => {
  const { client, calls } = recordingClient();
  const guarded = guardAppHeaderWrites(client);
  const notPlain = { name: localized, description: ['x'] };
  const patches = [
    `${API}/systemforms(${APP})`, `${API}/savedqueries(${APP})?$select=savedqueryid`, `${API}/sitemaps(${APP})`, `${API}/workflows(${APP})`, `${API}/webresourceset(${APP})`,
    `${API}/appmodulecomponents(${APP})`, `${API}/appmodules(${APP})/appmodule_something`, `${API}/appmoduleroles_association`, `${API}/appmodules`, `${API}/appmodule(${APP})`,
  ];
  for (const url of patches) await guarded.patch(url, notPlain);
  assert.strictEqual(calls.length, patches.length, 'every one of them was sent');
  // The create, a PUT and the rest of the verbs are not a header write of an existing app.
  await guarded.post(`${API}/appmodules`, notPlain);
  await guarded.put(`${API}/appmodules(${APP})`, notPlain);
  await guarded.get(`${API}/appmodules(${APP})`);
  await guarded.delete(`${API}/appmodules(${APP})`);
  assert.deepStrictEqual(calls.slice(patches.length).map((c) => c.verb), ['post', 'put', 'get', 'delete']);
  // A row of the app module table, however the URL is written.
  for (const url of [`${API}/appmodules(${APP})`, `${API}/appmodules(${APP})/`, `${API}/appmodules(${APP.toUpperCase()})?$select=appmoduleid&x=(y)`, `${API}/APPMODULES(${APP})`, `/api/data/v9.0/appmodules(${APP})`]) {
    await assert.rejects(guarded.patch(url, notPlain), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT, url);
  }
});

test('the other members of the client are reached as they are at each call — a method added or replaced after the wrap, one the client lacks, a frozen client', async () => {
  const { client, calls } = recordingClient();
  const guarded = guardAppHeaderWrites(client);
  assert.strictEqual(typeof guarded.postRaw, 'undefined', 'a member the client lacks is still lacking: the SDK reads its absence');
  client.postRaw = async (...args) => { calls.push({ verb: 'postRaw', args }); return 'raw'; };
  assert.strictEqual(await guarded.postRaw('u', 'b'), 'raw', 'one it gains later is seen');
  const replaced = async () => 'replaced';
  client.get = replaced;
  assert.strictEqual(await guarded.get('u'), 'replaced', 'a test that wraps a method after the SDK was made is still in the path');
  client.patch = async (...args) => { calls.push({ verb: 'patch2', args }); return 'patched'; };
  assert.strictEqual(await guarded.patch(ROW, { name: 'x' }), 'patched', 'the guard calls the client\'s patch as it is when it is called');
  assert.strictEqual(calls.at(-1).verb, 'patch2');
  const frozen = Object.freeze({ get: async () => 'g', patch: async () => 'p' });
  const guardedFrozen = guardAppHeaderWrites(frozen);
  assert.notStrictEqual(guardedFrozen, frozen);
  assert.strictEqual(await guardedFrozen.get('u'), 'g');
  assert.strictEqual(await guardedFrozen.patch(ROW, { name: 'x' }), 'p');
  await assert.rejects(guardedFrozen.patch(ROW, { name: ['x'] }), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
});

test('a client with no patch, nothing at all, or one that is already guarded is returned as it is — never a second layer', () => {
  const bare = { get: async () => 1 };
  assert.strictEqual(guardAppHeaderWrites(bare), bare);
  for (const none of [undefined, null, 0, '', 'client']) assert.strictEqual(guardAppHeaderWrites(none), none);
  const { client } = recordingClient();
  const once = guardAppHeaderWrites(client);
  assert.notStrictEqual(once, client);
  assert.strictEqual(guardAppHeaderWrites(once), once);
  // What a caller layers on top of a guarded client keeps the guard (it inherits it).
  const layered = Object.assign(Object.create(once), { get: async () => 'layer' });
  assert.strictEqual(guardAppHeaderWrites(layered), layered);
});

test('the plugin\'s own client is never asked for a token, and sends nothing, for a write that is refused', async () => {
  const sent = [];
  let tokens = 0;
  const real = createAzHttpClient('https://contoso.crm.dynamics.com', { getToken: () => { tokens += 1; return 'TOK'; }, request: async (r) => { sent.push(r); return { statusCode: 204, headers: {}, body: '' }; }, sleep: async () => {} });
  const guarded = guardAppHeaderWrites(real);
  await assert.rejects(guarded.patch(ROW, { name: localized, description: 'Tickets' }, OPTIONS), (e) => e.code === APP_HEADER_NOT_PLAIN_TEXT);
  assert.deepStrictEqual([sent.length, tokens], [0, 0]);
  const ok = await guarded.patch(ROW, { name: 'Probe', description: 'Tickets' }, OPTIONS);
  assert.strictEqual(ok.status, 204);
  assert.deepStrictEqual([sent.length, tokens], [1, 1]);
  assert.strictEqual(sent[0].method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(sent[0].body), { name: 'Probe', description: 'Tickets' });
});

// --- how a header text that is not plain reads -------------------------------------------------------------------------------------------------------------

test('a text that is not plain reads as what it is — a text per language, or the kind of thing it came back as', () => {
  assert.strictEqual(describeHeldAppText([{ key: 'name', have: localized }]), 'the app\'s name is localized (2 languages: 1033, 1036)');
  assert.strictEqual(describeHeldAppText([{ key: 'name', have: { 1033: 'Probe' } }]), 'the app\'s name is localized (1 language: 1033)');
  assert.strictEqual(describeHeldAppText([{ key: 'description', have: ['x'] }]), 'the app\'s description could not be read as plain text (it came back as a list)');
  assert.strictEqual(describeHeldAppText([{ key: 'name', have: 7 }, { key: 'description', have: null }]), 'the app\'s name could not be read as plain text (it came back as a number) and its description could not be read as plain text (it came back as null)');
  assert.strictEqual(describeHeldAppText([{ key: 'name', have: undefined }]), 'the app\'s name could not be read as plain text (it came back as no value)');
  assert.deepStrictEqual(nonPlainHeaderTexts({ name: 'a', description: 'b' }), []);
  assert.deepStrictEqual(nonPlainHeaderTexts({ name: localized, description: 3 }), [{ key: 'name', have: localized }, { key: 'description', have: 3 }]);
});

// --- the wiring: every SDK a script makes ------------------------------------------------------------------------------------------------------------------

test('every SDK the plugin makes is given the guarded client, the bundle\'s own SdkError is the refusal, and a caller that names no client gets none', async () => {
  const { withVendoredCompiler, SdkError } = require('../lib/maker-sdk.js');
  const create = withVendoredCompiler((options) => options);
  const { client, calls } = recordingClient();
  const made = create({ instanceUrl: 'https://contoso.crm.dynamics.com', httpClient: client });
  assert.notStrictEqual(made.httpClient, client, 'the SDK is handed the guarded client');
  assert.strictEqual(made.instanceUrl, 'https://contoso.crm.dynamics.com', 'the rest of the options pass through');
  await assert.rejects(made.httpClient.patch(ROW, { name: localized, description: 'Tickets' }, OPTIONS), (e) => {
    assert.ok(e instanceof SdkError, 'an SdkError, which the bundle rethrows as it is instead of wrapping it in a ConnectionError');
    assert.strictEqual(e.code, APP_HEADER_NOT_PLAIN_TEXT);
    assert.strictEqual(e.transient, false);
    return true;
  });
  assert.deepStrictEqual(calls, []);
  await made.httpClient.patch(ROW, { name: 'Probe', description: 'Tickets' }, OPTIONS);
  assert.strictEqual(calls.length, 1);
  // No client: no key is added. A client with no patch is the caller's own.
  assert.deepStrictEqual(Object.keys(create({ instanceUrl: 'https://contoso.crm.dynamics.com' })).sort(), ['instanceUrl', 'typescript']);
  const noPatch = { get: async () => 1 };
  assert.strictEqual(create({ httpClient: noPatch }).httpClient, noPatch);
  // A client the caller guarded itself is not guarded again.
  const mine = guardAppHeaderWrites(client);
  assert.strictEqual(create({ httpClient: mine }).httpClient, mine);
});

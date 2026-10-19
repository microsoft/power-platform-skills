'use strict';
// scripts/write-app-spec-doc.js with --env, end to end through its main(): what it reads of the environment (the app, and the roles associated with it —
// nothing else, and nothing written), what the document and the warnings say of it, and that a read that cannot be made never costs the document.
// The SDK and the HTTP client are stubs here; the real bundle is driven in app-roles.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const { withThrowawaySdk } = require('../lib/throwaway-sdk.js');
const { extensionSpec, grant } = require('./helpers/app-access-specs.js');

const SCRIPT = path.resolve(__dirname, '..', 'write-app-spec-doc.js');
const ENV = 'https://contoso.crm.dynamics.com';
const APP_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_PM = '00000000-0000-4000-8000-000000000001';
const ROLE_VIEWER = '00000000-0000-4000-8000-000000000002';
const ADMIN_ONLY = /only for (system )?admin|opens only|administrator-only|admin-only|only administrators/i;

// Runs main() over a folder holding `spec`. `sdk` is what the throwaway SDK is: { resolveArtifact, dataverse: { get } } — a method the command may not
// call is simply not there, so a stray call is a TypeError. The stubbed emitResult ends the run as the real one does.
async function run({ spec = extensionSpec(), argv = ['--env', ENV], sdk, clientError } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appdoc-env-'));
  const events = [];
  const emitted = [];
  try {
    const specPath = path.join(dir, 'app-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
    const requires = {
      './lib/dataverse-auth.js': {
        ...realAuth,
        emitResult: (ok, payload) => {
          emitted.push({ ok, payload });
          const exit = new Error(`process.exit(${ok ? 0 : 1})`);
          exit.exitCode = ok ? 0 : 1;
          throw exit;
        },
      },
      // The throwaway-workspace lifecycle is the real one (lib/throwaway-sdk.js); only the SDK and the client it makes are stubs.
      './lib/throwaway-sdk.js': {
        withThrowawaySdk: (options, runWith) => withThrowawaySdk({
          ...options,
          deps: {
            createAzHttpClient: (env) => {
              events.push({ type: 'client', env });
              if (clientError) throw clientError;
              return { marker: 'az-client', env };
            },
            makerSdk: {
              createNodeWorkspaceStorage: (workspace) => ({ workspace }),
              createMakerSdk: (cfg) => { events.push({ type: 'sdk', cfg }); return sdk(events); },
            },
          },
        }, runWith),
      },
    };
    const cli = loadCli(SCRIPT, { requires, argv: ['--spec', `@${specPath}`, ...argv] });
    let exitCode = 0;
    try {
      await cli.main();
    } catch (err) {
      if (typeof err.exitCode !== 'number') throw err;
      exitCode = err.exitCode;
    }
    const payload = emitted.length ? emitted[0].payload : undefined;
    const docPath = payload && payload.docPath;
    const sdkEvent = events.find((e) => e.type === 'sdk');
    return {
      events,
      exitCode,
      payload,
      stderr: cli.stderrText(),
      doc: docPath && fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : null,
      workspaceKept: sdkEvent ? fs.existsSync(sdkEvent.cfg.workspaceStorage.workspace) : null,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The SDK of an environment where the app exists with these roles. Every call is recorded. `resolve` answers the SDK's lookup of the app in the saved layer (what a
// draft is found by): the rows it answers, [] for no app. `body` is the whole body of the association answer, when a test needs one that is no list.
const sdkWith = ({ appId = APP_ID, rows = [{ roleid: ROLE_PM, name: 'Contoso PM - Project Manager', ismanaged: true }, { roleid: ROLE_VIEWER, name: 'Contoso PM - Viewer', ismanaged: false }], body, status = 200, resolve, get } = {}) => (events) => ({
  resolveArtifact: async (type, query) => {
    events.push({ type: 'resolveArtifact', kind: type, query });
    return resolve ? resolve(type, query) : [{ id: appId, name: 'Contoso PM', appModuleIdUnique: '33333333-3333-4333-8333-333333333333' }];
  },
  dataverse: {
    get: async (url) => {
      events.push({ type: 'get', url });
      if (get) return get(url);
      return { status, headers: {}, body: status >= 300 ? { error: { message: 'denied' } } : (body !== undefined ? body : { value: rows }) };
    },
  },
});
const reads = (r) => r.events.filter((e) => e.type === 'resolveArtifact' || e.type === 'get');

test('with --env it finds the app in the saved layer, reads the roles associated with it, and reads nothing else', async () => {
  const r = await run({ sdk: sdkWith() });
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(reads(r), [
    { type: 'resolveArtifact', kind: 'app', query: { uniqueName: 'contoso_pm' } },
    { type: 'get', url: `/appmodules(${APP_ID})/appmoduleroles_association?$select=roleid,name,ismanaged` },
  ]);
  assert.strictEqual(r.events.find((e) => e.type === 'client').env, ENV);
  assert.match(r.doc, /The app `contoso_pm` already exists in https:\/\/contoso\.crm\.dynamics\.com and these roles are associated with it/);
  assert.match(r.doc, /\| Contoso PM - Project Manager \| not touched by this spec \|/);
  assert.match(r.doc, /\| Contoso PM - Viewer \| not touched by this spec \|/);
  assert.doesNotMatch(r.doc, ADMIN_ONLY);
});

test('the roles come out in a fixed order, whichever order the platform answers', async () => {
  const rows = [{ roleid: ROLE_VIEWER, name: 'Contoso PM - Viewer' }, { roleid: ROLE_PM, name: 'Contoso PM - Project Manager' }, { roleid: '00000000-0000-4000-8000-000000000003', name: 'contoso auditor' }];
  const a = await run({ sdk: sdkWith({ rows }) });
  const b = await run({ sdk: sdkWith({ rows: [...rows].reverse() }) });
  assert.strictEqual(a.doc, b.doc);
  assert.ok(a.doc.indexOf('| contoso auditor |') < a.doc.indexOf('| Contoso PM - Project Manager |'));
});

test('the warnings carry what the environment said: a role grant to a role the app does not have, and a new table nothing grants', async () => {
  const spec = extensionSpec();
  spec.roleGrants = [grant('Contoso PM - Auditor', 'contoso_baseline')];
  const r = await run({ spec, sdk: sdkWith() });
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.ok(r.payload.warnings.some((w) => /roleGrants\[\] role "Contoso PM - Auditor" is not among the roles associated with app 'contoso_pm'/.test(w)), JSON.stringify(r.payload.warnings));
  assert.ok(!r.payload.warnings.some((w) => /no access declared/.test(w)), 'the grant covers the table');
});

test('the output of a successful run is still { ok, docPath, bytes, warnings }', async () => {
  const r = await run({ sdk: sdkWith() });
  assert.deepStrictEqual(Object.keys(r.payload), ['ok', 'docPath', 'bytes', 'warnings']);
  assert.strictEqual(r.payload.ok, true);
});

test('an app neither layer has is a new app: nothing more is read, and the document says so', async () => {
  const r = await run({ sdk: sdkWith({ resolve: async () => [] }) });
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(reads(r).map((e) => e.type), ['resolveArtifact'], 'no app, no association to read');
  assert.match(r.doc, /The app `contoso_pm` does not exist in https:\/\/contoso\.crm\.dynamics\.com yet/);
  assert.ok(r.payload.warnings.some((w) => /does not exist in https:\/\/contoso\.crm\.dynamics\.com yet/.test(w)), JSON.stringify(r.payload.warnings));
});

test('an app that was saved and never published exists: its roles are read if the platform answers, and the access is "not checked" if it does not — never "does not exist"', async () => {
  // The saved layer holds the draft; the platform answers a read of its roles with 404 while it has no published row.
  const refused = await run({ sdk: sdkWith({ status: 404 }) });
  assert.strictEqual(refused.exitCode, 0, refused.stderr);
  assert.doesNotMatch(refused.doc, /does not exist/);
  assert.match(refused.doc, /could not be read from https:\/\/contoso\.crm\.dynamics\.com \(HTTP 404\), so who can open it was not checked/);
  assert.ok(refused.payload.warnings.some((w) => /\(HTTP 404\) — who can open it was not checked/.test(w)), JSON.stringify(refused.payload.warnings));
  assert.ok(!refused.payload.warnings.some((w) => /does not exist|opens only for administrators/.test(w)), JSON.stringify(refused.payload.warnings));
  const answered = await run({ sdk: sdkWith() });
  assert.match(answered.doc, /already exists in https:\/\/contoso\.crm\.dynamics\.com and these roles are associated with it/);
});

test('an answer that carries no list of roles is "not checked": the document and the warnings say no role is associated only when the platform said so', async () => {
  for (const body of [{}, { value: 'malformed' }, { value: [{}] }, null]) {
    const r = await run({ sdk: sdkWith({ get: async () => ({ status: 200, headers: {}, body }) }) });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.doc, /could not be read from https:\/\/contoso\.crm\.dynamics\.com \(.+\), so who can open it was not checked/, JSON.stringify(body));
    assert.doesNotMatch(r.doc, /no role is associated with it/, JSON.stringify(body));
    assert.ok(!r.payload.warnings.some((w) => /with no role associated with it/.test(w)), JSON.stringify(r.payload.warnings));
  }
  const none = await run({ sdk: sdkWith({ rows: [] }) });
  assert.match(none.doc, /no role is associated with it, so only administrators and other makers/);
});

test('an app with no role associated with it is reported, with the evidence the read gave', async () => {
  const r = await run({ sdk: sdkWith({ rows: [] }) });
  assert.match(r.doc, /no role is associated with it, so only administrators and other makers/);
  assert.ok(r.payload.warnings.some((w) => /with no role associated with it/.test(w)), JSON.stringify(r.payload.warnings));
});

test('a read the platform refuses does not fail the document: it says the access was not checked, and why', async () => {
  const r = await run({ sdk: sdkWith({ status: 403 }) });
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.ok(r.doc, 'the document was written');
  assert.match(r.doc, /could not be read from https:\/\/contoso\.crm\.dynamics\.com \(HTTP 403\), so who can open it was not checked/);
  assert.ok(r.payload.warnings.some((w) => /could not be read from .*\(HTTP 403\) — who can open it was not checked/.test(w)), JSON.stringify(r.payload.warnings));
  assert.doesNotMatch(r.doc, ADMIN_ONLY);
});

test('a read that throws — in the SDK, the lookup of the app, or the token — does not fail the document either', async () => {
  const cases = {
    'the lookup of the app': { sdk: sdkWith({ resolve: async () => { throw new Error('the lookup was refused'); } }), reason: /the lookup was refused/ },
    'the roles read': { sdk: sdkWith({ get: async () => { throw new Error('socket hang up'); } }), reason: /socket hang up/ },
    'the HTTP client': { sdk: sdkWith(), clientError: new Error('az is not signed in'), reason: /az is not signed in/ },
  };
  for (const [what, { reason, ...options }] of Object.entries(cases)) {
    const r = await run(options);
    assert.strictEqual(r.exitCode, 0, `${what}: ${r.stderr}`);
    assert.ok(r.doc, `${what}: the document was written`);
    assert.match(r.doc, /could not be read from/, what);
    assert.match(r.doc, reason, what);
    assert.ok(r.payload.warnings.some((w) => /who can open it was not checked/.test(w)), `${what}: ${JSON.stringify(r.payload.warnings)}`);
  }
});

test('an --env that is not a Dataverse origin reads nothing, and the document is written with the reason', async () => {
  for (const env of ['https://example.com', 'contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/api/data/v9.2']) {
    const r = await run({ argv: ['--env', env], sdk: sdkWith() });
    assert.strictEqual(r.exitCode, 0, `${env}: ${r.stderr}`);
    assert.deepStrictEqual(r.events, [], `${env}: no client, no SDK`);
    assert.match(r.doc, /could not be read from/, env);
    assert.match(r.doc, /is not a Dataverse environment URL/, env);
    assert.match(r.doc, new RegExp(`\\| Environment \\| ${env.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\|`), 'the Environment row is what it always was');
  }
});

test('a spec that does not identify its app cannot be looked up, and says so', async () => {
  const spec = extensionSpec();
  delete spec.app.uniqueName;
  delete spec.solution;
  const r = await run({ spec, sdk: sdkWith() });
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(r.events, [], 'nothing to look up, so no client and no SDK');
  assert.match(r.doc, /could not be read from/);
  assert.match(r.doc, /does not name the app/);
});

test('without --env nothing is made: no client, no SDK, no read', async () => {
  const r = await run({ argv: [], sdk: sdkWith() });
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.deepStrictEqual(r.events, []);
  assert.match(r.doc, /not by this spec/);
  assert.match(r.doc, /--env/);
});

test('the throwaway workspace the SDK was made over is removed whichever way the read ended', async () => {
  for (const sdk of [sdkWith(), sdkWith({ status: 500 }), sdkWith({ get: async () => { throw new Error('boom'); } })]) {
    const r = await run({ sdk });
    assert.strictEqual(r.workspaceKept, false);
  }
});

test('--env adds the Environment row and the access section to the document, and changes nothing else in it', async () => {
  const spec = extensionSpec();
  spec.personas = [{ persona: 'Planner', jobs: [{ name: 'Plan', privileges: [{ entity: 'contoso_baseline', access: ['read'] }], surfaces: ['Baselines'] }] }];
  const offline = await run({ spec, argv: [], sdk: sdkWith() });
  const online = await run({ spec, sdk: sdkWith() });
  assert.ok(online.doc.includes('### Access to the app'));
  assert.ok(!offline.doc.includes('### Access to the app'));
  const withoutWhatEnvAdds = online.doc
    .replace(/\| Environment \| [^\n]* \|\n/, '')
    .replace(/\n### Access to the app\n[\s\S]*?(?=\n## |\n### |$)/, '');
  assert.strictEqual(withoutWhatEnvAdds.replace(/\n{3,}/g, '\n\n').trimEnd(), offline.doc.replace(/\n{3,}/g, '\n\n').trimEnd());
});

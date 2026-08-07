'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readerFor, appIdFor } = require('../verify-model-app.js');

const GP_OVERVIEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_DETAIL   = '5c0a4889-45fd-46ea-91a8-ff876914d644';

// SDK stub that provides enough surface for readerFor (appId resolution, sitemap, webresource).
// `sitemap` when provided causes stubSdk to route appmodulecomponent + sitemap queries appropriately
// so fetchSitemap returns { ok:true, xml, ids }.
function stubSdk({ webresource = [], sitemap = null } = {}) {
  return {
    queryRecords: async (set) => {
      if (set === 'appmodule') return [{ appmoduleid: 'app-uuid-1', appmoduleidunique: 'uid-1' }];
      if (set === 'appmodulecomponent') return sitemap ? [{ objectid: 'sm-1', componenttype: 62 }] : [];
      if (set === 'sitemap') return sitemap ? [{ sitemapxml: sitemap }] : [];
      if (set === 'webresource') return webresource;
      return [];
    },
    findTables: async () => [],
    findColumns: async () => [],
  };
}

// SDK where appmodule returns empty → fetchSitemap gets { ok:false, reason:'app-not-found' }.
function noAppSdk() {
  return { queryRecords: async () => [], findTables: async () => [], findColumns: async () => [] };
}

test('readerFor.existenceIds() calls enumerateEnv(), memoized to one call, throws on failure', async () => {
  let calls = 0;
  const genpageCli = { enumerateEnv: async () => { calls++; return { ok: true, ids: [GP_OVERVIEW, GP_DETAIL] }; } };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: os.tmpdir() });

  const ids = await reader.existenceIds();
  assert.deepStrictEqual(ids, [GP_OVERVIEW, GP_DETAIL]);
  await reader.existenceIds(); // second call — must NOT re-invoke enumerateEnv (memoized)
  assert.strictEqual(calls, 1, 'enumerateEnv called exactly once (memoized per verify run)');

  // Failure path: enumerateEnv !ok → existenceIds must throw (fail-closed — unknown env means cannot verify).
  const failing = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: false, error: 'auth expired' }) },
    workspaceDir: os.tmpdir(),
  });
  await assert.rejects(failing.existenceIds(), /auth expired/i);
});

test('readerFor.sitemapPageIds() returns page ids from fetchSitemap; throws when sitemap unreadable', async () => {
  const xml = `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}"/><SubArea GenPageId="${GP_DETAIL}"/></Group></Area></SiteMap>`;
  const reader = readerFor(stubSdk({ sitemap: xml }), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  const ids = await reader.sitemapPageIds();
  assert.ok(ids.includes(GP_OVERVIEW.toLowerCase()), 'GP_OVERVIEW in sitemapPageIds');
  assert.ok(ids.includes(GP_DETAIL.toLowerCase()), 'GP_DETAIL in sitemapPageIds');

  // Failure: fetchSitemap returns !ok (app-not-found) → sitemapPageIds must throw (fail-closed).
  const failing = readerFor(noAppSdk(), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  await assert.rejects(failing.sitemapPageIds(), /could not read the app sitemap/i);
});

test('readerFor.manifest() returns null when webresource absent; parsed manifest when valid; null when corrupt', async () => {
  // Absent: no webresource row → manifest() returns null (verifySpec will set unableToRun on a page-bearing spec).
  const readAbsent = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  assert.strictEqual(await readAbsent.manifest(), null, 'manifest null when webresource absent');

  // Valid: webresource.content = base64 of valid manifest JSON → manifest() returns parsed object.
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_OVERVIEW }] };
  const b64 = Buffer.from(JSON.stringify(manifest)).toString('base64');
  const readPresent = readerFor(stubSdk({ webresource: [{ content: b64 }] }), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  const m = await readPresent.manifest();
  assert.ok(m && m.pages[0].pageId === GP_OVERVIEW, 'manifest parsed when webresource is valid');

  // Corrupt: base64 of non-JSON → parseManifestBase64 returns null → manifest() returns null.
  const corruptB64 = Buffer.from('this is not valid json!').toString('base64');
  const readCorrupt = readerFor(stubSdk({ webresource: [{ content: corruptB64 }] }), 'contoso_app', {
    genpageCli: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  assert.strictEqual(await readCorrupt.manifest(), null, 'manifest null when webresource is corrupt JSON');
});

test('readerFor.pageCode(id) downloads by id (pageIds:[id]), caches per id, throws on download failure', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
  let downloads = 0;
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, ids: [] }),
    // Simulate pac writing <outDir>/<pageId>/page.tsx (the per-id output layout).
    download: async ({ outputDir, pageIds }) => {
      downloads += 1;
      const id = pageIds[0];
      fs.mkdirSync(path.join(outputDir, id), { recursive: true });
      fs.writeFileSync(path.join(outputDir, id, 'page.tsx'), `// code for ${id}`, 'utf8');
      return true;
    },
  };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpageCli, workspaceDir: ws });

  const code = await reader.pageCode(GP_OVERVIEW);
  assert.ok(code.includes(GP_OVERVIEW), 'returned the page code for the requested id');

  await reader.pageCode(GP_OVERVIEW); // second call — same id — must NOT re-download
  assert.strictEqual(downloads, 1, 'download runs once per id (cached)');

  await reader.pageCode(GP_DETAIL); // different id → exactly one more download (per-id, not all-pages)
  assert.strictEqual(downloads, 2, 'each distinct id downloaded separately');

  // Download failure → throws so the build gate gets an error (fail-closed).
  const failing = readerFor(stubSdk(), 'contoso_app', {
    genpageCli: {
      enumerateEnv: async () => ({ ok: true, ids: [] }),
      download: async () => { throw new Error('pac download failed'); },
    },
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vf-')),
  });
  await assert.rejects(failing.pageCode(GP_OVERVIEW), /pac download failed/i);
});

test('readerFor WITHOUT a genpageCli has no sitemapPageIds/existenceIds/manifest/pageCode — verifySpec fails closed (Imp7/C6)', () => {
  const reader = readerFor(stubSdk(), 'contoso_app', {});
  // No genpageCli → page-authority methods absent → verifySpec detects reader-incapacity → unableToRun.
  assert.strictEqual(typeof reader.sitemapPageIds, 'undefined', 'no sitemapPageIds when no genpageCli');
  assert.strictEqual(typeof reader.existenceIds, 'undefined', 'no existenceIds when no genpageCli');
  assert.strictEqual(typeof reader.manifest, 'undefined', 'no manifest when no genpageCli');
  assert.strictEqual(typeof reader.pageCode, 'undefined', 'no pageCode when no genpageCli');
});

test('readerFor base readers normalize exact identities for tables, relationships, commands, and settings', async () => {
  const calls = [];
  const sdk = {
    findTables: async (logical) => {
      calls.push({ method: 'findTables', logical });
      return [{ logicalName: 'NEW_ACCOUNT' }, { logicalName: 'new_contact' }];
    },
    findColumns: async (logical) => {
      calls.push({ method: 'findColumns', logical });
      return [{ logicalName: `${logical}_name` }];
    },
    queryRecords: async () => [],
    fetchEntityMetadata: async (logical) => {
      calls.push({ method: 'fetchEntityMetadata', logical });
      return {
        Relationships: [
          { SchemaName: 'new_Parent_Child' },
          { schemaName: 'new_lower' },
          { name: 'new_named' },
          {},
        ],
      };
    },
    resolveArtifact: async (kind, identity) => {
      calls.push({ method: 'resolveArtifact', kind, identity });
      return [{ id: 'cmd-1' }];
    },
    retrieveSetting: async (name, opts) => {
      calls.push({ method: 'retrieveSetting', name, opts });
      return { value: '2' };
    },
  };
  const reader = readerFor(sdk, 'contoso_app', {});

  assert.deepStrictEqual(await reader.findTable('NEW_ACCOUNT'), { logicalName: 'NEW_ACCOUNT' });
  assert.deepStrictEqual(await reader.findColumns('new_account'), [{ logicalName: 'new_account_name' }]);
  assert.deepStrictEqual(await reader.entityRelationships('NEW_CHILD'), ['new_parent_child', 'new_lower', 'new_named']);
  assert.strictEqual(await reader.commandBar('NEW_ACCOUNT'), true);
  assert.deepStrictEqual(await reader.retrieveSetting('NLGridSearchSetting'), { value: '2' });
  assert.ok(calls.some((c) => c.method === 'findTables' && c.logical === 'new_account'));
  assert.ok(calls.some((c) => c.method === 'fetchEntityMetadata' && c.logical === 'new_child'));
  assert.ok(calls.some((c) => c.method === 'resolveArtifact' && c.identity.entity === 'new_account'));
  assert.ok(calls.some((c) => c.method === 'retrieveSetting' && c.opts && Object.keys(c.opts).length === 0));
});

test('appIdFor returns the deployed app id or undefined when the app is already gone', async () => {
  const filters = [];
  const sdk = {
    queryRecords: async (set, opts) => {
      filters.push(opts.filter);
      return /missing/.test(opts.filter) ? [] : [{ appmoduleid: 'app-uuid-1' }];
    },
  };

  assert.strictEqual(await appIdFor(sdk, 'contoso_app'), 'app-uuid-1');
  assert.strictEqual(await appIdFor(sdk, 'missing_app'), undefined);
  assert.ok(filters.every((f) => /uniquename eq '/.test(f)), 'app lookup stays name-scoped');
});

function loadVerifyCli({ parseResult, validateResult = { ok: true }, verifyResult = { ok: true, checks: [], missing: [] }, sdkThrows = null, invokeAsMain = false }) {
  const scriptPath = path.join(__dirname, '..', 'verify-model-app.js');
  const source = `${fs.readFileSync(scriptPath, 'utf8')}\nmodule.exports.__mainForTest = main;\n`;
  const events = [];
  const stderr = [];
  const mod = { exports: {} };
  const fakeFs = {
    mkdirSync: (dir, opts) => events.push({ type: 'mkdirSync', dir, opts }),
  };
  const customRequire = (id) => {
    if (id === 'node:fs') return fakeFs;
    if (id === 'node:path') return path;
    if (id === './lib/dataverse-auth.js') {
      return {
        parseArgs: () => parseResult,
        readJsonArg: (arg) => {
          events.push({ type: 'readJsonArg', arg });
          return { app: { name: 'Support Desk' }, solution: { publisherPrefix: 'new' } };
        },
        emitResult: (ok, payload) => events.push({ type: 'emitResult', ok, payload }),
      };
    }
    if (id === './lib/sdk-http-client.js') {
      return { createAzHttpClient: (env) => ({ env }) };
    }
    if (id === './lib/verify-spec.js') {
      return {
        verifySpec: async (spec, read) => {
          events.push({ type: 'verifySpec', spec, hasReader: typeof read.findTable === 'function' });
          return verifyResult;
        },
      };
    }
    if (id === './lib/sdk-build.js') {
      return { appUniqueName: () => 'new_supportdesk' };
    }
    if (id === './lib/app-spec.js') {
      return {
        validateAppSpec: () => validateResult,
        migrateAppSpec: (spec) => {
          events.push({ type: 'migrateAppSpec', spec });
          return { ...spec, migrated: true };
        },
      };
    }
    if (id === './lib/odata.js') {
      return { odataLit: (value) => String(value).replace(/'/g, "''") };
    }
    if (id === './lib/genpage-cli.js') {
      return { makeGenpageCli: (env) => { events.push({ type: 'makeGenpageCli', env }); return { env }; } };
    }
    if (id === './lib/sitemap-pages.js') {
      return {
        fetchSitemap: async () => ({ ok: true, xml: '<SiteMap />' }),
        sitemapGenPageIds: () => [],
      };
    }
    if (id === './lib/page-manifest.js') {
      return {
        manifestResourceName: (appUnique) => `${appUnique}_pagemanifest`,
        parseManifestBase64: () => null,
      };
    }
    if (id === './vendor/cds-maker-sdk.cjs') {
      return {
        createMakerSdk: (cfg) => {
          events.push({ type: 'createMakerSdk', cfg });
          if (sdkThrows) throw sdkThrows;
          return {
            initWorkspace: () => events.push({ type: 'initWorkspace' }),
            findTables: async () => [],
            findColumns: async () => [],
            queryRecords: async () => [],
            fetchEntityMetadata: async () => ({ Relationships: [] }),
            resolveArtifact: async () => [],
            retrieveSetting: async () => null,
          };
        },
      };
    }
    return require(id);
  };
  customRequire.main = invokeAsMain ? mod : {};
  const sandboxProcess = {
    argv: ['node', scriptPath],
    stderr: { write: (message) => stderr.push(message) },
    exit: (code) => {
      const err = new Error(`process.exit(${code})`);
      err.exitCode = code;
      throw err;
    },
  };
  vm.runInNewContext(source, {
    require: customRequire,
    module: mod,
    exports: mod.exports,
    process: sandboxProcess,
    Buffer,
    setImmediate,
  }, { filename: scriptPath });
  return { main: mod.exports.__mainForTest, events, stderr, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test('verify CLI rejects a bare --workspace before provisioning an SDK', async () => {
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: { env: 'https://org.example', spec: '@app-spec.json', workspace: true } },
  });

  await assert.rejects(harness.main(), (err) => err.exitCode === 1);
  assert.match(harness.stderr.join(''), /Usage: node verify-model-app\.js/);
  assert.ok(!harness.events.some((e) => e.type === 'createMakerSdk'), 'usage errors never initialize the SDK');
});

test('verify CLI emits structured validation failures without touching Dataverse', async () => {
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: { env: 'https://org.example', spec: '@D:\\Projects\\power-platform-skills-sdk\\plugins\\model-apps\\samples\\bad.json' } },
    validateResult: { ok: false, errors: ['entities must be a non-empty array'] },
  });

  await harness.main();
  const emitted = harness.events.find((e) => e.type === 'emitResult');
  assert.strictEqual(emitted.ok, false);
  assert.deepStrictEqual(emitted.payload.errors, ['entities must be a non-empty array']);
  assert.ok(!harness.events.some((e) => e.type === 'createMakerSdk'), 'invalid specs halt before SDK construction');
});

test('verify CLI prints per-check status and aliases missing checks into emitResult errors', async () => {
  const missing = { kind: 'view', name: 'new_ticket.Open Tickets', present: false };
  const harness = loadVerifyCli({
    parseResult: {
      positional: [],
      flags: {
        env: 'https://org.example',
        spec: '@D:\\Projects\\power-platform-skills-sdk\\plugins\\model-apps\\samples\\app-spec.support-desk.json',
        workspace: 'D:\\Projects\\power-platform-skills-sdk\\.test-workspace\\verify',
      },
    },
    verifyResult: {
      ok: false,
      checks: [{ kind: 'entity', name: 'new_ticket', present: true }, missing],
      missing: [missing],
    },
  });

  await harness.main();
  const stderr = harness.stderr.join('');
  const emitted = harness.events.find((e) => e.type === 'emitResult');

  assert.match(stderr, /✓ entity: new_ticket/);
  assert.match(stderr, /✗ view: new_ticket\.Open Tickets/);
  assert.match(stderr, /✗ verify FAIL — 1 missing \(1\/2 present\)/);
  assert.strictEqual(emitted.ok, false);
  assert.deepStrictEqual(emitted.payload.errors, ['view:new_ticket.Open Tickets']);
  assert.ok(harness.events.some((e) => e.type === 'mkdirSync' && /\\.test-workspace\\verify$/.test(e.dir)));
  assert.ok(harness.events.some((e) => e.type === 'initWorkspace'));
});

test('verify CLI accepts a positional spec, uses the default workspace, and prints PASS', async () => {
  // Build the path with `path.join` rather than a hard-coded `D:\...` literal: the CLI derives the
  // default workspace via path.join, so on a POSIX runner it produces `samples/.maker-workspace`
  // and a backslash-anchored assertion could never match (this test failed on every non-Windows CI
  // runner for that reason, not because the CLI was wrong).
  const specPath = path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json');
  const harness = loadVerifyCli({
    parseResult: { positional: [specPath], flags: { env: 'https://org.example' } },
    verifyResult: {
      ok: true,
      checks: [{ kind: 'entity', name: 'new_ticket', present: true }],
      missing: [],
    },
  });

  await harness.main();
  const stderr = harness.stderr.join('');
  const emitted = harness.events.find((e) => e.type === 'emitResult');

  assert.match(stderr, /✓ verify PASS \(1\/1 present\)/);
  assert.strictEqual(emitted.ok, true);
  assert.deepStrictEqual(emitted.payload.missing, []);
  assert.ok(harness.events.some((e) => e.type === 'createMakerSdk' && e.cfg.workspacePath === path.join(__dirname, '..', '..', 'samples', '.maker-workspace')));
});

test('verify CLI entrypoint converts SDK startup errors into emitResult failures', async () => {
  const harness = loadVerifyCli({
    parseResult: {
      positional: [],
      flags: {
        env: 'https://org.example',
        spec: '@D:\\Projects\\power-platform-skills-sdk\\plugins\\model-apps\\samples\\app-spec.support-desk.json',
      },
    },
    sdkThrows: new Error('SDK unavailable'),
    invokeAsMain: true,
  });

  await harness.settle();
  const emitted = harness.events.find((e) => e.type === 'emitResult');
  assert.strictEqual(emitted.ok, false);
  assert.match(emitted.payload.message, /SDK unavailable/);
});

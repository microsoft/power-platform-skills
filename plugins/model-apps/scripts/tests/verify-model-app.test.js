'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { readerFor, appIdFor } = require('../verify-model-app.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { validateFlagsFromParsed } = require('./helpers/fake-auth.js');
const { appSpec, column, nameColumn } = require('./helpers/column-gate-specs.js');
const dashboardReads = require('./helpers/dashboard-two-language-reads.js');
const { workbookXml, exportZip, exportAnswer } = require('./helpers/translation-export.js');

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
  const genpage = { enumerateEnv: async () => { calls++; return { ok: true, ids: [GP_OVERVIEW, GP_DETAIL] }; } };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpage, workspaceDir: os.tmpdir() });

  const ids = await reader.existenceIds();
  assert.deepStrictEqual(ids, [GP_OVERVIEW, GP_DETAIL]);
  await reader.existenceIds(); // second call — must NOT re-invoke enumerateEnv (memoized)
  assert.strictEqual(calls, 1, 'enumerateEnv called exactly once (memoized per verify run)');

  // Failure path: enumerateEnv !ok → existenceIds must throw (fail-closed — unknown env means cannot verify).
  const failing = readerFor(stubSdk(), 'contoso_app', {
    genpage: { enumerateEnv: async () => ({ ok: false, error: 'auth expired' }) },
    workspaceDir: os.tmpdir(),
  });
  await assert.rejects(failing.existenceIds(), /auth expired/i);
});

test('readerFor.sitemapPageIds() returns page ids from fetchSitemap; throws when sitemap unreadable', async () => {
  const xml = `<SiteMap><Area><Group><SubArea GenPageId="${GP_OVERVIEW}"/><SubArea GenPageId="${GP_DETAIL}"/></Group></Area></SiteMap>`;
  const reader = readerFor(stubSdk({ sitemap: xml }), 'contoso_app', {
    genpage: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  const ids = await reader.sitemapPageIds();
  assert.ok(ids.includes(GP_OVERVIEW.toLowerCase()), 'GP_OVERVIEW in sitemapPageIds');
  assert.ok(ids.includes(GP_DETAIL.toLowerCase()), 'GP_DETAIL in sitemapPageIds');

  // Failure: fetchSitemap returns !ok (app-not-found) → sitemapPageIds must throw (fail-closed).
  const failing = readerFor(noAppSdk(), 'contoso_app', {
    genpage: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  await assert.rejects(failing.sitemapPageIds(), /could not read the app sitemap/i);
});

test('readerFor.manifest() returns null when webresource absent; parsed manifest when valid; null when corrupt', async () => {
  // Absent: no webresource row → manifest() returns null (verifySpec will set unableToRun on a page-bearing spec).
  const readAbsent = readerFor(stubSdk(), 'contoso_app', {
    genpage: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  assert.strictEqual(await readAbsent.manifest(), null, 'manifest null when webresource absent');

  // Valid: webresource.content = base64 of valid manifest JSON → manifest() returns parsed object.
  const manifest = { schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: GP_OVERVIEW }] };
  const b64 = Buffer.from(JSON.stringify(manifest)).toString('base64');
  const readPresent = readerFor(stubSdk({ webresource: [{ content: b64 }] }), 'contoso_app', {
    genpage: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  const m = await readPresent.manifest();
  assert.ok(m && m.pages[0].pageId === GP_OVERVIEW, 'manifest parsed when webresource is valid');

  // Corrupt: base64 of non-JSON → parseManifestBase64 returns null → manifest() returns null.
  const corruptB64 = Buffer.from('this is not valid json!').toString('base64');
  const readCorrupt = readerFor(stubSdk({ webresource: [{ content: corruptB64 }] }), 'contoso_app', {
    genpage: { enumerateEnv: async () => ({ ok: true, ids: [] }) },
    workspaceDir: os.tmpdir(),
  });
  assert.strictEqual(await readCorrupt.manifest(), null, 'manifest null when webresource is corrupt JSON');
});

test('readerFor.pageCode(id) reads the page by id, caches per id, throws on read failure', async () => {
  let reads = 0;
  const genpage = {
    enumerateEnv: async () => ({ ok: true, ids: [] }),
    read: async (id) => {
      reads += 1;
      return { id, name: 'Page', source: `// code for ${id}` };
    },
  };
  const reader = readerFor(stubSdk(), 'contoso_app', { genpage, workspaceDir: os.tmpdir() });

  const code = await reader.pageCode(GP_OVERVIEW);
  assert.ok(code.includes(GP_OVERVIEW), 'returned the page code for the requested id');

  await reader.pageCode(GP_OVERVIEW); // second call — same id — must NOT re-read
  assert.strictEqual(reads, 1, 'the page is read once per id (cached)');

  await reader.pageCode(GP_DETAIL); // different id → exactly one more read (per-id, not all-pages)
  assert.strictEqual(reads, 2, 'each distinct id is read separately');

  // Read failure → throws so the build gate gets an error (fail-closed).
  const failing = readerFor(stubSdk(), 'contoso_app', {
    genpage: {
      enumerateEnv: async () => ({ ok: true, ids: [] }),
      read: async () => { throw new Error('page read failed'); },
    },
    workspaceDir: os.tmpdir(),
  });
  await assert.rejects(failing.pageCode(GP_OVERVIEW), /page read failed/i);
});

test('readerFor WITHOUT a page backend has no sitemapPageIds/existenceIds/manifest/pageCode — verifySpec fails closed', () => {
  const reader = readerFor(stubSdk(), 'contoso_app', {});
  // No page backend → page-authority methods absent → verifySpec detects reader-incapacity → unableToRun.
  assert.strictEqual(typeof reader.sitemapPageIds, 'undefined', 'no sitemapPageIds when no page backend');
  assert.strictEqual(typeof reader.existenceIds, 'undefined', 'no existenceIds when no page backend');
  assert.strictEqual(typeof reader.manifest, 'undefined', 'no manifest when no page backend');
  assert.strictEqual(typeof reader.pageCode, 'undefined', 'no pageCode when no page backend');
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
      return { Relationships: [] };
    },
    dataverse: {
      get: async (p) => {
        calls.push({ method: 'dataverse.get', path: p });
        if (p.includes('/ManyToOneRelationships')) {
          return { status: 200, body: { value: [
            { SchemaName: 'new_Parent_Child', ReferencedEntity: 'new_parent', ReferencingAttribute: 'new_parentid' },
            { SchemaName: 'new_lower', ReferencedEntity: 'new_other', ReferencingAttribute: 'new_otherid' },
          ] } };
        }
        if (p.includes('/ManyToManyRelationships')) {
          return { status: 200, body: { value: [{ SchemaName: 'new_named', Entity1LogicalName: 'new_child', Entity2LogicalName: 'new_tag' }] } };
        }
        return { status: 200, body: { value: [] } };
      },
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
  const relRows = await reader.entityRelationships('NEW_CHILD');
  assert.deepStrictEqual(relRows.map((r) => r.schemaName), ['new_Parent_Child', 'new_lower', 'new_named']);
  assert.strictEqual(relRows[0].referencingEntity, 'new_child', 'the queried table is the referencing end of a ManyToOne row');
  assert.strictEqual(await reader.commandBar('NEW_ACCOUNT'), true);
  assert.deepStrictEqual(await reader.retrieveSetting('NLGridSearchSetting'), { value: '2' });
  assert.ok(calls.some((c) => c.method === 'findTables'));
  assert.ok(calls.some((c) => c.method === 'dataverse.get' && /ManyToOneRelationships/.test(c.path)));
  assert.ok(calls.some((c) => c.method === 'resolveArtifact' && c.identity.entity === 'new_account'));
  assert.ok(calls.some((c) => c.method === 'retrieveSetting' && c.opts && Object.keys(c.opts).length === 0));
});

test('readerFor + verifySpec reads deployed fetchxml and systemform.isdefault through the real reader seam', async () => {
  const calls = [];
  const sdk = {
    findTables: async () => [],
    findColumns: async () => [],
    queryRecords: async (set, opts) => {
      calls.push({ set, opts });
      if (set === 'savedquery') {
        return [{
          savedqueryid: 'view-1',
          layoutxml: '<grid><row><cell name="new_subject"/></row></grid>',
          fetchxml: '<fetch><entity name="new_ticket"><filter><condition attribute="ownerid" operator="eq-userid"/></filter></entity></fetch>',
        }];
      }
      if (set === 'systemform') return [{ formid: 'form-1', isdefault: false }];
      return [];
    },
    fetchEntityMetadata: async () => ({ Relationships: [] }),
    resolveArtifact: async () => [],
    retrieveSetting: async () => null,
  };
  const spec = {
    solution: { publisherPrefix: 'new' },
    app: { name: 'Support Desk', uniqueName: 'new_supportdesk' },
    entities: [{ schemaName: 'new_ticket', columns: [] }], charts: [], appShell: { areas: [] },
    views: [{ entity: 'new_ticket', name: 'My Tickets', columns: ['new_subject'], activeOnly: false, filters: [{ attr: 'modifiedon', op: 'this-week' }] }],
    forms: [{ entity: 'new_ticket', name: 'Main', formType: 'Main', isDefault: true }],
  };

  const r = await verifySpec(spec, readerFor(sdk, 'new_supportdesk', {}));

  assert.ok(r.missing.some((m) => m.kind === 'view-filters' && /modifiedon this-week/.test(m.detail)), 'the real reader must surface fetchxml to the filter oracle');
  assert.ok(r.missing.some((m) => m.kind === 'form-default' && /isdefault is false/.test(m.detail)), 'the real reader must surface systemform.isdefault to the default-form oracle');
  const viewQuery = calls.find((c) => c.set === 'savedquery');
  assert.ok(viewQuery.opts.select.includes('fetchxml'), 'view reads must request savedquery.fetchxml');
  const formDefaultQuery = calls.find((c) => c.set === 'systemform' && /formid eq form-1/.test(c.opts.filter));
  assert.ok(formDefaultQuery, 'default-form proof must read the deployed form row by id');
  assert.ok(formDefaultQuery.opts.select.includes('isdefault'), 'default-form proof must request systemform.isdefault');
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

test('readerFor.appRoleIds reads the deployed appmoduleroles_association rows', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async (set, opts) => {
      calls.push({ set, opts });
      if (set === 'appmodule') return [{ appmoduleid: 'app-id-1' }];
      return [];
    },
    findTables: async () => [],
    findColumns: async () => [],
    dataverse: {
      get: async (url) => {
        calls.push({ url });
        return {
          status: 200,
          headers: {},
          body: { value: [{ roleid: 'role-agent' }, { roleid: 'ROLE-MANAGER' }] },
        };
      },
    },
  };

  const res = await readerFor(sdk, 'contoso_app', {}).appRoleIds();

  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.roleIds, ['role-agent', 'role-manager']);
  assert.ok(calls.some((c) => c.url && /appmodules\(app-id-1\)\/appmoduleroles_association/.test(c.url)), 'must read the actual app-role association navigation property');
});

test('readerFor.appRoleIds fails closed when the association rows cannot be read', async () => {
  const sdk = {
    queryRecords: async (set) => (set === 'appmodule' ? [{ appmoduleid: 'app-id-1' }] : []),
    findTables: async () => [],
    findColumns: async () => [],
    dataverse: { get: async () => ({ status: 403, headers: {}, body: { error: { message: 'forbidden' } } }) },
  };

  const res = await readerFor(sdk, 'contoso_app', {}).appRoleIds();

  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /403/);
});

function loadVerifyCli({ parseResult, validateResult = { ok: true }, verifyResult = { ok: true, checks: [], missing: [] }, sdkThrows = null, invokeAsMain = false, specObject = null, realGates = false, sdkFactory = null, disposeOutcome }) {
  const scriptPath = path.join(__dirname, '..', 'verify-model-app.js');
  const source = `${fs.readFileSync(scriptPath, 'utf8')}\nmodule.exports.__mainForTest = main;\n`;
  const events = [];
  const stderr = [];
  const mod = { exports: {} };
  const made = new Set();
  const fakeFs = {
    mkdirSync: (dir, opts) => { made.add(dir); events.push({ type: 'mkdirSync', dir, opts }); },
    // The throwaway workspace verify's SDK works in: created by name, removed when the run ends. Recorded so a test
    // can tell it from the app folder's workspace, which verify never creates or opens.
    mkdtempSync: (prefix) => { const dir = `${prefix}x1y2z3`; made.add(dir); events.push({ type: 'mkdtempSync', dir }); return dir; },
    rmSync: (dir, opts) => { events.push({ type: 'rmSync', dir, opts }); },
    // The workspace check inspects the final component, then creates a missing directory and
    // inspects it again. A double that only records mkdir would throw here and hide the call.
    lstatSync: (dir) => {
      if (!made.has(dir)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
    },
    readlinkSync: () => {
      const err = new Error('EINVAL');
      err.code = 'EINVAL';
      throw err;
    },
    realpathSync: Object.assign((p) => p, { native: (p) => p }),
  };
  const customRequire = (id) => {
    if (id === 'node:fs') return fakeFs;
    if (id === 'node:path') return path;
    // The throwaway workspaces are made by the plugin's one maker of them (lib/temp-workspace.js), which works on the real file system: the harness stands
    // in for it with the very call the script made before it existed, so what this test pins — each is made under the OS temp folder, by name, and removed — is as it was.
    if (id === './lib/temp-workspace.js') return { makeTempWorkspace: (prefix) => fakeFs.mkdtempSync(path.join(os.tmpdir(), prefix)) };
    if (id === './lib/dataverse-auth.js') {
      return {
        parseArgs: () => parseResult,
        validateFlags: validateFlagsFromParsed(() => parseResult.flags),
        readJsonArg: (arg) => {
          events.push({ type: 'readJsonArg', arg });
          return specObject || { app: { name: 'Support Desk' }, solution: { publisherPrefix: 'new' } };
        },
        emitResult: (ok, payload, options) => events.push({ type: 'emitResult', ok, payload, options }),
        // Pure, so the real one — the CLI uses it to identify the environment's baseline.
        dataverseOrigin: require('../lib/dataverse-auth.js').dataverseOrigin,
        // Pure as well: the `--language-code` flag, read the way the build reads it.
        readLanguageCodeFlag: require('../lib/dataverse-auth.js').readLanguageCodeFlag,
      };
    }
    if (id === './lib/sdk-http-client.js') {
      // One client is made for the run; the page backend must be given that same one (its token is shared), so each is recorded — with what it was made with, which is how a test
      // can tell the one request the run sends only once (the translation export).
      return { createAzHttpClient: (env, deps) => { const client = { env }; events.push({ type: 'createAzHttpClient', client, deps }); return client; } };
    }
    if (!realGates && id === './lib/verify-spec.js') {
      return {
        verifySpec: async (spec, read, opts) => {
          events.push({ type: 'verifySpec', spec, hasReader: typeof read.findTable === 'function', opts });
          return verifyResult;
        },
      };
    }
    if (id === './lib/sdk-build.js') {
      return { appUniqueName: () => 'new_supportdesk' };
    }
    if (!realGates && id === './lib/app-spec.js') {
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
    if (id === './lib/genpage-sdk.js') {
      // The page backend the CLI makes: what it was made for and what it was given are recorded, so a test can tell that it works in a workspace of its
      // own (it is lent no SDK) through the run's own HTTP client, and that it is disposed before the result is printed.
      return {
        makeGenpageSdk: (env, deps) => {
          events.push({ type: 'makeGenpageSdk', env, deps });
          return { env, dispose: async (options) => { events.push({ type: 'genpageDispose', options }); return disposeOutcome; } };
        },
      };
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
    if (id === './lib/maker-sdk.js') {
        return {
          // The CLI builds its store explicitly via the /node adapter now, so the mocked bundle
          // must expose it too. The marker carries the root so the assertions below can still
          // check WHERE the throwaway workspace was placed.
          createNodeWorkspaceStorage: (root) => ({ __mockWorkspaceRoot: root }),
        createMakerSdk: (cfg) => {
          events.push({ type: 'createMakerSdk', cfg });
          if (sdkThrows) throw sdkThrows;
          if (sdkFactory) return sdkFactory(cfg);
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
    // Fallback for any require the intercepts above do not cover. Relative ids must resolve against
    // the SCRIPT's directory, not this test file's — the sandbox runs verify-model-app.js source, so
    // `./lib/x.js` means `scripts/lib/x.js`. Resolving it here (rather than adding an intercept per
    // module) means a new `./lib/...` import in the script does not silently break every CLI test
    // with "Cannot find module".
    if (id.startsWith('./') || id.startsWith('../')) {
      return require(path.resolve(path.dirname(scriptPath), id));
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
  // `--workspace` names only where the build's baseline is read from: verify creates nothing there, and its SDK
  // works in a throwaway workspace of its own, removed before the result is printed.
  assert.ok(!harness.events.some((e) => e.type === 'mkdirSync' && /\.test-workspace/.test(e.dir)), 'the named workspace is not created');
  assert.ok(harness.events.some((e) => e.type === 'initWorkspace'));
  const sdkRoot = harness.events.find((e) => e.type === 'createMakerSdk').cfg.workspaceStorage.__mockWorkspaceRoot;
  assert.doesNotMatch(sdkRoot, /\.test-workspace/, 'the SDK is not opened on the named workspace');
  const removed = harness.events.findIndex((e) => e.type === 'rmSync' && e.dir === sdkRoot);
  assert.ok(removed > -1, 'the throwaway workspace is removed');
  assert.ok(removed < harness.events.findIndex((e) => e.type === 'emitResult'), 'before emitResult ends the process');
});

// A build run with `--language-code` publishes its tab and section captions in that language, which may not be the organization's, and verify
// can only hold them to the right one when it is told: it takes the flag the build takes, spelled either way, and hands it to the verification.
const SPEC_FLAGS = { env: 'https://org.example', spec: '@app-spec.json' };
const verifyCall = (harness) => harness.events.find((e) => e.type === 'verifySpec');

test('verify CLI takes the build\'s --language-code (or --languageCode) and hands the language to the verification', async () => {
  for (const flags of [{ 'language-code': '1036' }, { languageCode: '1036' }, { 'language-code': ' 1036 ', languageCode: '1036' }]) {
    const harness = loadVerifyCli({ parseResult: { positional: [], flags: { ...SPEC_FLAGS, ...flags } } });
    await harness.main();
    assert.strictEqual(verifyCall(harness).opts.languageCode, 1036, JSON.stringify(flags));
    assert.ok('baselineSpec' in verifyCall(harness).opts, 'the baseline is still handed over');
  }
  // Without the flag verify is told nothing — the spec's language, then the organization's, decide, as for a build with no flag.
  const plain = loadVerifyCli({ parseResult: { positional: [], flags: SPEC_FLAGS } });
  await plain.main();
  assert.strictEqual(verifyCall(plain).opts.languageCode, undefined);
});

test('verify CLI refuses a --language-code that is no LCID, a pair that disagrees, and a bare flag, before it opens an SDK', async () => {
  for (const [what, flags, message] of [
    ['a language tag', { 'language-code': 'de-DE' }, /--language-code \/ --languageCode must be digits only, a positive integer LCID up to 65535 \(got 'de-DE'\)/],
    ['zero', { languageCode: '0' }, /must be digits only/],
    ['too large', { 'language-code': '65536' }, /must be digits only/],
    ['two flags that disagree', { 'language-code': '1031', languageCode: '1036' }, /--language-code '1031' and --languageCode '1036' disagree — pass only one/],
    ['a flag with no value', { 'language-code': true }, /--language-code/],
    ['a flag with an empty value', { languageCode: '' }, /--languageCode/],
  ]) {
    const harness = loadVerifyCli({ parseResult: { positional: [], flags: { ...SPEC_FLAGS, ...flags } } });
    await assert.rejects(harness.main(), (err) => err.exitCode === 1, what);
    assert.match(harness.stderr.join(''), message, what);
    assert.match(harness.stderr.join(''), /Usage: node verify-model-app\.js .*\[--language-code\|--languageCode <lcid>\]/, `${what}: the usage names the flag`);
    assert.ok(!harness.events.some((e) => e.type === 'createMakerSdk' || e.type === 'verifySpec'), `${what}: nothing was opened or read`);
  }
});

// A check verify could not decide is neither a pass nor a failure. It is listed — on stderr, and in the JSON result a skill reads — so a green
// run never reads as "everything the spec declares is deployed" while a label was not compared.
test('verify CLI lists what it could not verify, beside the PASS, in the output and the result — and says nothing when there is none', async () => {
  const unverified = ['form-labels:new_ticket.Ticket Main (the label of tab \'tab_overview\' was not compared: the language the build wrote it in could not be established (the organization read failed: 503). Pass --language-code <lcid> (the one the build was run with) or set "languageCode" in the spec to compare them)'];
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: SPEC_FLAGS },
    verifyResult: { ok: true, checks: [{ kind: 'entity', name: 'new_ticket', present: true }], missing: [], unverified },
  });
  await harness.main();
  const stderr = harness.stderr.join('');
  const emitted = harness.events.find((e) => e.type === 'emitResult');
  assert.match(stderr, /✓ verify PASS \(1\/1 present\)/, 'the verdict on what was checked is unchanged');
  assert.ok(stderr.includes(`⊘ ${unverified[0]}`), `the unverified check is named, with its reason: ${stderr}`);
  assert.match(stderr, /⊘ 1 check could not be verified — it is neither passed nor failed/);
  assert.strictEqual(emitted.ok, true, 'it does not fail the run');
  assert.deepStrictEqual(emitted.payload.unverified, unverified, 'the machine channel carries it');
  assert.deepStrictEqual(emitted.payload.missing, []);

  const none = loadVerifyCli({ parseResult: { positional: [], flags: SPEC_FLAGS } });
  await none.main();
  assert.doesNotMatch(none.stderr.join(''), /⊘/);
  assert.ok(!('unverified' in none.events.find((e) => e.type === 'emitResult').payload), 'the result keeps its shape when nothing was left unverified');
});

// A form built in a language the environment's form read does not show: live, Spanish (3082) captions in an organization whose base language is English
// (1033), read back with the form's labels in English only. Run as the CLI runs — the real verification over a reader built on an SDK that answers what the
// platform answered — a verify told the language by either spelling of the flag, or by a pin in the spec, compares nothing it cannot read back: the
// captions are listed unverified, the rest of the layout is checked, and the run ends clean.
const SPANISH_FORM_ID = '00000000-0000-4000-8000-000000000001';
const spanishFormSpec = (over = {}) => ({
  solution: { uniqueName: 'FormProbe', displayName: 'Form Probe', publisherPrefix: 'new' },
  app: { name: 'Form Probe', uniqueName: 'new_formprobe' },
  entities: [{ schemaName: 'new_ticket', displayName: 'Ticket', existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] }],
  forms: [{ entity: 'new_ticket', name: 'Main', formType: 'Main', layout: 'explicit', prune: false, notes: false,
    tabs: [{ name: 'tab_main', label: 'Resumen', sections: [{ name: 'sec_main', label: 'Detalles', columns: 1, fields: ['new_name'] }] }] }],
  ...over,
});
// The published form as a read returns it, with the captions `tab` and `section` (each `<label …/>` markup), and the ids the tab and the section have in the FormXML.
const spanishFormXml = ({ tab, section, ids = { tab: '{1}', section: '{2}' } }) => `<form><tabs><tab id="${ids.tab}" name="tab_main" expanded="true" visible="true"><labels>${tab}</labels><columns><column width="100%"><sections>`
  + `<section id="${ids.section}" name="sec_main" showlabel="true" visible="true" columns="1"><labels>${section}</labels><rows><row><cell id="{3}"><control id="new_name" classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}" datafieldname="new_name" /></cell></row></rows></section>`
  + '</sections></column></columns></tab></tabs><DisplayConditions Order="0" FallbackForm="true"><Everyone /></DisplayConditions></form>';
const englishLabels = { tab: '<label description="Overview" languagecode="1033" />', section: '<label description="Basics" languagecode="1033" />' };
// `post` is the SDK's Dataverse client's `post`, which a translation export is asked for through: with none, the SDK has no client that can ask.
const formSdk = (formxml, { post } = {}) => () => ({
  initWorkspace: async () => {},
  findTables: async () => [{ logicalName: 'new_ticket' }],
  findColumns: async () => [{ logicalName: 'new_name' }],
  queryRecords: async (set) => (set === 'systemform' ? [{ formid: SPANISH_FORM_ID, name: 'Main', objecttypecode: 'new_ticket', type: 2, isdefault: true, formxml }] : []),
  fetchEntityMetadata: async () => ({ Relationships: [] }),
  resolveArtifact: async () => [],
  retrieveSetting: async () => null,
  dataverse: {
    get: async (p) => {
      if (/WhoAmI/.test(String(p))) return { status: 200, body: { UserId: '11111111-2222-3333-4444-555555555555' } };
      if (/RetrieveFilteredForms/.test(String(p))) return { status: 200, body: { value: [{ formid: SPANISH_FORM_ID }] } };
      return { status: 200, body: { value: [] } };
    },
    ...(post ? { post } : {}),
  },
});
const runSpanishVerify = async (flags, { spec = spanishFormSpec(), labels = englishLabels, ids, post } = {}) => {
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: { ...SPEC_FLAGS, ...flags } },
    realGates: true,
    specObject: spec,
    sdkFactory: formSdk(spanishFormXml({ ...labels, ...(ids ? { ids } : {}) }), { post }),
  });
  await harness.main();
  return { harness, emitted: harness.events.find((e) => e.type === 'emitResult') };
};

test('verify CLI over a form read that carries only English — --language-code 3082, --languageCode 3082 and a spec pin — lists the Spanish captions unverified and exits clean, whose translation export cannot be asked for', async () => {
  for (const [what, flags, spec] of [
    ['--language-code 3082', { 'language-code': '3082' }, spanishFormSpec()],
    ['--languageCode 3082', { languageCode: '3082' }, spanishFormSpec()],
    ['both spellings', { 'language-code': '3082', languageCode: '3082' }, spanishFormSpec()],
    ['languageCode pinned in the spec', {}, spanishFormSpec({ languageCode: 3082 })],
  ]) {
    const { harness, emitted } = await runSpanishVerify(flags, { spec });
    const stderr = harness.stderr.join('');
    assert.strictEqual(emitted.ok, true, `${what}: the exit status is the verdict on what was compared — ${JSON.stringify(emitted.payload)}`);
    assert.deepStrictEqual(emitted.payload.missing, [], `${what}: no caption is reported missing`);
    assert.strictEqual(emitted.payload.present, emitted.payload.total, what);
    assert.strictEqual(emitted.payload.unverified.length, 1, `${what}: ${JSON.stringify(emitted.payload.unverified)}`);
    assert.match(emitted.payload.unverified[0], /^form-labels:new_ticket\.Main \(the labels of tab 'tab_main', section 'sec_main' in language 3082 were not compared: the environment's form read returns labels only in 1033, so labels written in 3082 cannot be read back from it\. A translation export of solution 'FormProbe' could not be read \(the SDK has no Dataverse client that can post a translation export request\)\. Check them in Power Apps with that language, or verify in a language the read carries\)$/, what);
    assert.match(stderr, /✓ verify PASS/, what);
    assert.match(stderr, /⊘ 1 check could not be verified — it is neither passed nor failed/, what);
    assert.ok(stderr.includes(`⊘ ${emitted.payload.unverified[0]}`), `${what}: the entry is named, with its reason`);
  }
});

// The form's tab and section as the platform keeps them: GUIDs, in braces and capitals as a classic form writes them, and the export that has the Spanish captions of both.
const SPANISH_IDS = { tab: '{0A0A0A0A-0000-4000-8000-000000000001}', section: '{0A0A0A0A-0000-4000-8000-000000000002}' };
const spanishExport = (over = {}) => exportAnswer(exportZip(workbookXml({ captions: [
  { entity: 'new_ticket', id: SPANISH_IDS.tab.slice(1, -1).toLowerCase(), texts: { 1033: 'Overview', 3082: 'Resumen', ...(over.tab || {}) } },
  { entity: 'new_ticket', id: SPANISH_IDS.section.slice(1, -1).toLowerCase(), texts: { 1033: 'Basics', 3082: 'Detalles', ...(over.section || {}) } },
] })));

test('verify CLI settles the Spanish captions from ONE translation export asked for through the SDK\'s Dataverse client — the run passes with nothing left unverified', async () => {
  for (const [what, flags, spec] of [
    ['--language-code 3082', { 'language-code': '3082' }, spanishFormSpec()],
    ['languageCode pinned in the spec', {}, spanishFormSpec({ languageCode: 3082 })],
  ]) {
    const asked = [];
    const { harness, emitted } = await runSpanishVerify(flags, { spec, ids: SPANISH_IDS, post: async (p, body) => { asked.push({ p, body }); return spanishExport(); } });
    assert.strictEqual(emitted.ok, true, `${what}: ${JSON.stringify(emitted.payload)}`);
    assert.deepStrictEqual(emitted.payload.missing, [], what);
    assert.ok(!('unverified' in emitted.payload), `${what}: the export settled both captions`);
    assert.deepStrictEqual(asked, [{ p: '/solutions/Microsoft.Dynamics.CRM.ExportTranslation', body: { SolutionName: 'FormProbe' } }], `${what}: one request, to the bound action`);
    assert.doesNotMatch(harness.stderr.join(''), /⊘/, what);
  }
  // A caption the export shows differently fails the run, by name.
  const stale = await runSpanishVerify({ 'language-code': '3082' }, { ids: SPANISH_IDS, post: async () => spanishExport({ tab: { 3082: 'Antiguo' } }) });
  assert.strictEqual(stale.emitted.ok, false);
  assert.match(stale.emitted.payload.missing[0], /^form-topology:new_ticket\.Main \(deployed layout does not match the authored one — tab 'tab_main' is deployed with label "Antiguo" in language 3082 \(the translation export of solution 'FormProbe' shows it; the form read does not carry language 3082\), the spec declares label: "Resumen" in language 3082\)$/);
  assert.match(stale.harness.stderr.join(''), /✗ verify FAIL — 1 missing/);
  assert.ok(!('unverified' in stale.emitted.payload));
});

test('verify CLI lists the captions unverified, and exits clean, when the translation export fails — the reason is in the entry', async () => {
  const refused = await runSpanishVerify({ 'language-code': '3082' }, { ids: SPANISH_IDS, post: async () => ({ status: 403, headers: {}, body: { error: { message: 'Principal user is missing prvExportTranslation privilege' } } }) });
  assert.strictEqual(refused.emitted.ok, true, JSON.stringify(refused.emitted.payload));
  assert.strictEqual(refused.emitted.payload.unverified.length, 1);
  assert.match(refused.emitted.payload.unverified[0], /A translation export of solution 'FormProbe' could not be read \(HTTP 403: Principal user is missing prvExportTranslation privilege\)\. Check them in Power Apps/);
  assert.match(refused.harness.stderr.join(''), /✓ verify PASS/);
  const thrown = await runSpanishVerify({ 'language-code': '3082' }, { ids: SPANISH_IDS, post: async () => { throw new Error('socket hang up'); } });
  assert.strictEqual(thrown.emitted.ok, true);
  assert.match(thrown.emitted.payload.unverified[0], /could not be read \(the request failed: socket hang up\)/);
  // A form read that carries the language asks for no export.
  let asked = 0;
  const carries = await runSpanishVerify({ 'language-code': '3082' }, { ids: SPANISH_IDS, post: async () => { asked += 1; return spanishExport(); }, labels: { tab: '<label description="Overview" languagecode="1033" /><label description="Resumen" languagecode="3082" />', section: '<label description="Basics" languagecode="1033" /><label description="Detalles" languagecode="3082" />' } });
  assert.strictEqual(carries.emitted.ok, true);
  assert.strictEqual(asked, 0);
});

test('verify CLI makes its HTTP client send the translation export once — and nothing else differently', async () => {
  const { harness } = await runSpanishVerify({ 'language-code': '3082' });
  const clients = harness.events.filter((e) => e.type === 'createAzHttpClient');
  assert.strictEqual(clients.length, 1, 'one client for the run');
  const { sendOnce } = clients[0].deps;
  assert.strictEqual(typeof sendOnce, 'function');
  const base = 'https://org.example/api/data/v9.2';
  assert.strictEqual(sendOnce('POST', `${base}/solutions/Microsoft.Dynamics.CRM.ExportTranslation`), true, 'a long action: a re-send would run it twice');
  for (const [method, url] of [['GET', `${base}/systemforms`], ['POST', `${base}/$batch`], ['POST', `${base}/ExportSolution`], ['PATCH', `${base}/systemforms(1)`]]) {
    assert.strictEqual(sendOnce(method, url), false, `${method} ${url} keeps the client's usual retry`);
  }
});

test('readerFor.translationLabels asks the SDK\'s Dataverse client for ONE export of the named solution, and answers { ok, languages, lookup } — or why it cannot', async () => {
  const calls = [];
  const sdk = {
    queryRecords: async () => [],
    dataverse: { post: async (p, body, options) => { calls.push({ p, body, options }); return spanishExport(); } },
  };
  const read = readerFor(sdk, 'contoso_app', {});
  const answer = await read.translationLabels('Contoso_Tickets');
  assert.strictEqual(answer.ok, true, JSON.stringify(answer));
  assert.deepStrictEqual(answer.languages, [1033, 3082]);
  assert.strictEqual(answer.lookup('new_ticket', SPANISH_IDS.tab).texts.get(3082), 'Resumen');
  assert.deepStrictEqual(calls.map(({ p, body }) => ({ p, body })), [{ p: '/solutions/Microsoft.Dynamics.CRM.ExportTranslation', body: { SolutionName: 'Contoso_Tickets' } }]);
  // Not kept between asks: the export is the published layer, and a later verify must see it change.
  await read.translationLabels('Contoso_Tickets');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(await readerFor({ queryRecords: async () => [] }, 'contoso_app', {}).translationLabels('Contoso_Tickets'), { ok: false, reason: 'the SDK has no Dataverse client that can post a translation export request' });
  const refused = await readerFor({ queryRecords: async () => [], dataverse: { post: async () => ({ status: 404, headers: {}, body: { error: { message: 'Resource not found for the segment \'ExportTranslation\'.' } } }) } }, 'contoso_app', {}).translationLabels('Contoso_Tickets');
  assert.deepStrictEqual(refused, { ok: false, reason: 'HTTP 404: Resource not found for the segment \'ExportTranslation\'.' });
});

test('verify CLI compares the Spanish captions strictly when the read carries them — a stale one still fails the run', async () => {
  const spanishToo = (tab) => ({
    tab: `<label description="Overview" languagecode="1033" /><label description="${tab}" languagecode="3082" />`,
    section: '<label description="Basics" languagecode="1033" /><label description="Detalles" languagecode="3082" />',
  });
  const right = await runSpanishVerify({ 'language-code': '3082' }, { labels: spanishToo('Resumen') });
  assert.strictEqual(right.emitted.ok, true, JSON.stringify(right.emitted.payload));
  assert.ok(!('unverified' in right.emitted.payload), 'the read shows Spanish: nothing is left it cannot tell');
  const stale = await runSpanishVerify({ 'language-code': '3082' }, { labels: spanishToo('Antiguo') });
  assert.strictEqual(stale.emitted.ok, false, 'a stale caption in a language the read carries fails, as ever');
  assert.match(stale.emitted.payload.missing[0], /^form-topology:new_ticket\.Main \(deployed layout does not match the authored one — tab 'tab_main' is deployed with label "Antiguo" in language 3082, the spec declares label: "Resumen" in language 3082\)$/);
  assert.ok(!('unverified' in stale.emitted.payload));
  assert.match(stale.harness.stderr.join(''), /✗ verify FAIL — 1 missing/);
});

// The page reads a pass gave up on can still be running when it ends, and only a workspace the backend made itself is one it can close — so it is not
// lent the run's SDK (whose folder the run removes). It is made lazily, when the first page is read, and disposed (closed, then removed) before the result is
// printed: emitResult ends the process, so a cleanup placed after it never runs.
test('verify CLI gives the page backend a workspace of its own and the run\'s HTTP client, and disposes it before the run\'s own workspace goes and the result is printed', async () => {
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: { env: 'https://org.example', spec: '@app-spec.json' } },
    verifyResult: { ok: true, checks: [{ kind: 'entity', name: 'new_ticket', present: true }], missing: [] },
    sdkFactory: () => ({
      initWorkspace: () => {},
      findTables: async () => [],
      findColumns: async () => [],
      queryRecords: async () => [],
      fetchEntityMetadata: async () => ({ Relationships: [] }),
      resolveArtifact: async () => [],
      retrieveSetting: async () => null,
      marker: 'the-run-sdk',
    }),
  });
  await harness.main();
  const made = harness.events.filter((e) => e.type === 'makeGenpageSdk');
  assert.strictEqual(made.length, 1, 'one page backend per run');
  assert.strictEqual(made[0].env, 'https://org.example');
  assert.strictEqual(made[0].deps.sdk, undefined, 'it is not lent the SDK the run\'s other reads use: its workspace is its own to close');
  const clients = harness.events.filter((e) => e.type === 'createAzHttpClient');
  assert.strictEqual(clients.length, 1, 'one HTTP client for the run');
  assert.strictEqual(made[0].deps.httpClient, clients[0].client, 'which the page backend shares, and so the Azure CLI token');
  assert.strictEqual(harness.events.filter((e) => e.type === 'createMakerSdk').length, 1, 'the run\'s SDK is the only one the CLI makes itself: the backend makes its own when a page is read');
  const sdkRoot = harness.events.find((e) => e.type === 'createMakerSdk').cfg.workspaceStorage.__mockWorkspaceRoot;
  const order = (type, match = () => true) => harness.events.findIndex((e) => e.type === type && match(e));
  assert.ok(order('genpageDispose') > -1, 'the backend is disposed');
  assert.ok(order('genpageDispose') < order('rmSync', (e) => e.dir === sdkRoot), 'before the run\'s workspace is removed');
  assert.ok(order('rmSync', (e) => e.dir === sdkRoot) < order('emitResult'), 'and both before emitResult ends the process');
});

// The final dispose is the last thing between the page's source and the end of the process. dispose() joins whatever cleanup the pass's ending of its reads
// left draining, so it can take as long as a storage call that never settles: the CLI bounds it, and says so when a workspace is still on disk — it is never
// reported as done while one is.
test('verify CLI bounds the final dispose of the page backend, and warns — instead of reporting done — when a workspace could not be removed', async () => {
  const run = async (disposeOutcome) => {
    const harness = loadVerifyCli({
      parseResult: { positional: [], flags: { env: 'https://org.example', spec: '@app-spec.json' } },
      verifyResult: { ok: true, checks: [{ kind: 'entity', name: 'new_ticket', present: true }], missing: [] },
      disposeOutcome,
    });
    await harness.main();
    return harness;
  };
  const clean = await run({ left: [] });
  const dispose = clean.events.find((e) => e.type === 'genpageDispose');
  assert.ok(dispose, 'the backend is disposed');
  assert.strictEqual(dispose.options.waitMs, 10000, 'within a bound: a backend that cannot answer does not hold the process for ever');
  assert.doesNotMatch(clean.stderr.join(''), /could not be removed/, 'nothing is said when every workspace is gone');

  const stuck = await run({ left: ['C:\\temp\\genpage-x1y2z3'] });
  assert.match(stuck.stderr.join(''), /WARNING: the page workspace could not be removed, so page source may be left on disk: C:\\temp\\genpage-x1y2z3/);
  assert.ok(stuck.events.some((e) => e.type === 'emitResult'), 'the result is still printed');
  assert.ok(stuck.events.findIndex((e) => e.type === 'genpageDispose') < stuck.events.findIndex((e) => e.type === 'emitResult'), 'after the backend answered, not before');
});

test('verify CLI accepts a positional spec, leaves the default workspace alone, and prints PASS', async () => {
  // Build the path with `path.join` rather than a hard-coded `D:\...` literal: the CLI derives the
  // default workspace via path.join, so on a POSIX runner it produces `samples/.maker-workspace`
  // and a backslash-anchored assertion could never match (this test failed on every non-Windows CI
  // runner for that reason, not because the CLI was wrong).
  const specPath = path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json');
  const defaultWorkspace = path.join(__dirname, '..', '..', 'samples', '.maker-workspace');
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
  // The default workspace is the build's, and belongs to the environment it was first opened for: verify neither
  // opens it for its SDK nor creates it (a read-only run must not bind a folder that has no workspace yet).
  const sdkRoots = harness.events.filter((e) => e.type === 'createMakerSdk').map((e) => e.cfg.workspaceStorage.__mockWorkspaceRoot);
  assert.ok(sdkRoots.length >= 1 && sdkRoots.every((root) => root !== defaultWorkspace && path.dirname(root) === os.tmpdir()), `the SDK works in a throwaway workspace: ${JSON.stringify(sdkRoots)}`);
  assert.ok(!harness.events.some((e) => e.type === 'mkdirSync' && e.dir === defaultWorkspace), 'the default workspace is not created');
});

// An older spec whose 1:N and N:N relationships share a schema name, over an environment that holds the 1:N: what verify must still read (the collision
// is a warning for it, an error everywhere else) and then fail on, naming the holder.
async function verifyCollidingSpec() {
  const specObject = {
    solution: { uniqueName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Projects', uniqueName: 'contoso_projects' },
    entities: [
      { schemaName: 'contoso_project', displayName: 'Project', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } },
      { schemaName: 'contoso_task', displayName: 'Task', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } },
    ],
    relationships: [
      { type: 'OneToMany', referenced: 'contoso_project', referencing: 'contoso_task', lookup: { schemaName: 'contoso_ProjectId', displayName: 'Project' } },
      { type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task' },
    ],
  };
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: { env: 'https://contoso.crm.dynamics.com', spec: '@app-spec.json', workspace: 'D:\\Projects\\_temp\\verify-collision' } },
    realGates: true,
    specObject,
    sdkFactory: () => ({
      initWorkspace: async () => {},
      findTables: async () => [{ logicalName: 'contoso_project' }, { logicalName: 'contoso_task' }],
      findColumns: async () => [{ logicalName: 'contoso_name' }],
      queryRecords: async () => [],
      fetchEntityMetadata: async () => ({ Relationships: [] }),
      resolveArtifact: async () => [],
      retrieveSetting: async () => null,
      dataverse: {
        get: async (p) => {
          if (String(p).includes('RelationshipType')) {
            return { status: 200, body: { '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: 'contoso_project_contoso_task', RelationshipType: 'OneToManyRelationship' } };
          }
          if (String(p).includes('OneToManyRelationshipMetadata')) {
            return { status: 200, body: { SchemaName: 'contoso_project_contoso_task', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' } };
          }
          return { status: 200, body: { value: [] } };
        },
      },
    }),
  });

  await harness.main();
  return { stderr: harness.stderr.join(''), emitted: harness.events.find((e) => e.type === 'emitResult') };
}

test('verify CLI still verifies an older colliding spec and names the holder', async () => {
  // Dropping relationshipCollisions: 'warn' makes validateAppSpec refuse this spec before any
  // read. The relationship line is the proof verification actually ran.
  const { stderr, emitted } = await verifyCollidingSpec();
  assert.match(stderr, /WARNING:.*both use the schema name 'contoso_project_contoso_task'/);
  assert.match(stderr, /exists as 1:N contoso_project -> contoso_task \(lookup contoso_projectid\), not as the declared N:N/);
  assert.ok(emitted && Array.isArray(emitted.payload.missing), 'a validation refusal returns errors and never a missing list');
  assert.ok(emitted.payload.missing.some((m) => /not as the declared N:N/.test(m)), JSON.stringify(emitted.payload));
});

// --- an app deployed from a spec an earlier release accepted can still be verified ----------------------------------------------------
// Two rules keep a BUILD from misreading a column's declaration (lib/app-spec.js): an AutoNumber column needs a format, and `required` is true, false or
// "recommended". Verification creates and updates nothing and only reads whether each column exists, so the spec of an app an earlier release built — an
// AutoNumber column made as plain text, a `required: "true"` made not required — must still reach the deployment. The CLI passes columnValues: 'warn', as it
// passes relationshipCollisions: 'warn': the findings are warnings that name the column and the fix, and the verdict is the deployment's.
async function verifyOlderSpec(specObject, harnessOptions = {}) {
  const reads = [];
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: { env: 'https://contoso.crm.dynamics.com', spec: '@app-spec.json', workspace: 'D:\\Projects\\_temp\\verify-older-spec' } },
    realGates: true,
    specObject,
    ...harnessOptions,
    sdkFactory: () => ({
      initWorkspace: async () => {},
      findTables: async () => { reads.push('tables'); return [{ logicalName: 'new_ticket' }]; },
      findColumns: async (name) => { reads.push(`columns ${name}`); return [{ logicalName: 'new_name' }, { logicalName: 'new_ref' }, { logicalName: 'new_status' }]; },
      queryRecords: async (set) => (set === 'appmodule' ? [{ appmoduleid: '11111111-2222-3333-4444-555555555555' }] : []),
      fetchEntityMetadata: async () => ({ Relationships: [] }),
      resolveArtifact: async () => [],
      retrieveSetting: async () => null,
    }),
  });
  await harness.main();
  return { reads, emitted: harness.events.find((e) => e.type === 'emitResult'), stderr: harness.stderr.join('') };
}

const OMIT_THE_KEY = "omit the key to leave an existing column's level as it is";
const OLDER_SPECS = [
  ['an AutoNumber column with no format', { columns: [column({ type: 'AutoNumber' })] },
    'column new_ref is an AutoNumber column but its autoNumberFormat is missing — give it a format such as "C-{SEQNUM:5}", or use type "Text" for a plain text column'],
  ['an AutoNumber column with a blank format', { columns: [column({ type: 'AutoNumber', autoNumberFormat: '  ' })] },
    'column new_ref is an AutoNumber column but its autoNumberFormat is blank — give it a format such as "C-{SEQNUM:5}", or use type "Text" for a plain text column'],
  ['a column whose required is null', { columns: [column({ type: 'Text', required: null })] },
    `column new_ref required must be true, false or "recommended" (got null) — true makes a column required, "recommended" makes it recommended and false makes it not required; ${OMIT_THE_KEY}`],
  ['a column whose required is the string "true"', { columns: [column({ type: 'Text', required: 'true' })] },
    `column new_ref required must be true, false or "recommended" (got "true") — write true for a required column; ${OMIT_THE_KEY}`],
  ['a column whose required is "ApplicationRequired"', { columns: [column({ type: 'Text', required: 'ApplicationRequired' })] },
    `column new_ref required must be true, false or "recommended" (got "ApplicationRequired") — write true for a required column; ${OMIT_THE_KEY}`],
  ['a primary name column whose required is "ApplicationRequired"', { primaryAttribute: nameColumn({ required: 'ApplicationRequired' }) },
    `primaryAttribute.required must be true, false or "recommended" (got "ApplicationRequired") — write true for a required column; ${OMIT_THE_KEY}`],
];

test('verify CLI still verifies the deployment of a spec an earlier release accepted — and warns, naming the column and the fix', async () => {
  for (const [label, parts, finding] of OLDER_SPECS) {
    const { reads, emitted, stderr } = await verifyOlderSpec(appSpec(parts));
    assert.ok(emitted, `${label}: a result is emitted`);
    assert.strictEqual(emitted.ok, true, `${label}: verification ran and passed — ${JSON.stringify(emitted.payload)}`);
    assert.ok(emitted.payload.total > 0 && emitted.payload.present === emitted.payload.total, `${label}: the deployment was checked — ${JSON.stringify(emitted.payload)}`);
    assert.ok(!('errors' in emitted.payload) || emitted.payload.errors.length === 0, `${label}: no schema error stops it — ${JSON.stringify(emitted.payload)}`);
    assert.ok(reads.includes('columns new_ticket'), `${label}: the deployed columns were read — ${JSON.stringify(reads)}`);
    assert.ok(stderr.includes(`WARNING: entity new_ticket: ${finding}\n`), `${label}: the warning names the column and the fix\n${stderr}`);
    assert.match(stderr, /✓ verify PASS/, label);
  }
});

test('verify CLI warns once for each finding of an older spec, in the spec\'s order, and still reaches the deployment', async () => {
  const spec = appSpec({
    columns: [column({ type: 'AutoNumber', required: 'true' }), column({ schemaName: 'new_status', type: 'Text', required: null })],
    primaryAttribute: nameColumn({ required: 'ApplicationRequired' }),
  });
  const { emitted, stderr } = await verifyOlderSpec(spec);
  assert.strictEqual(emitted.ok, true, JSON.stringify(emitted.payload));
  const warnings = stderr.split('\n').filter((line) => line.startsWith('WARNING: '));
  assert.deepStrictEqual(warnings.map((line) => line.slice(0, line.indexOf(' — '))), [
    'WARNING: entity new_ticket: primaryAttribute.required must be true, false or "recommended" (got "ApplicationRequired")',
    'WARNING: entity new_ticket: column new_ref is an AutoNumber column but its autoNumberFormat is missing',
    'WARNING: entity new_ticket: column new_ref required must be true, false or "recommended" (got "true")',
    'WARNING: entity new_ticket: column new_status required must be true, false or "recommended" (got null)',
  ]);
});

test('verify CLI says nothing about these rules for a spec that satisfies them, and gives the same verdict', async () => {
  const spec = appSpec({ columns: [column({ type: 'AutoNumber', autoNumberFormat: 'C-{SEQNUM:5}', required: 'recommended' })], primaryAttribute: nameColumn({ required: false }) });
  const { reads, emitted, stderr } = await verifyOlderSpec(spec);
  assert.strictEqual(emitted.ok, true, JSON.stringify(emitted.payload));
  assert.ok(emitted.payload.total > 0 && emitted.payload.present === emitted.payload.total, JSON.stringify(emitted.payload));
  assert.ok(reads.includes('columns new_ticket'), JSON.stringify(reads));
  assert.ok(!/WARNING:/.test(stderr), `no warning: ${stderr}`);
  assert.match(stderr, /✓ verify PASS/);
});

test('verify CLI still refuses a spec that is invalid for another reason — before any read — and the column rules are no part of that refusal', async () => {
  const spec = appSpec({ columns: [column({ type: 'AutoNumber' }), column({ schemaName: 'new_bad', type: 'Nope' })] });
  const { reads, emitted } = await verifyOlderSpec(spec);
  assert.strictEqual(emitted.ok, false);
  assert.deepStrictEqual(emitted.payload.errors, ["entity new_ticket: column new_bad has unknown type 'Nope'"]);
  assert.deepStrictEqual(reads, [], 'nothing was read');
});

// --- a form whose fieldOptions entry carries a key it does not take -------------------------------------------------------------------
// The build and the lint refuse a key a `fieldOptions` entry does not take, but a release before that check accepted one and built the form
// without the option. Verification keeps the deploy profile, whose checks of forms and pages it relies on, and passes fieldOptionKeys: 'warn':
// the finding is a warning that names the key and the option it most likely meant, and the verdict is the deployment's. The form of these specs
// is not in the fake environment, so its check fails: what is pinned is that the check ran.
const FIELD_OPTION_TYPO = "form 'Ticket' (table new_ticket): unknown key 'readOnlyy' on fieldOptions['new_ref'] — did you mean 'readOnly'? (allowed: readOnly, hidden, after, colspan, rowspan)";
const withTypoForm = (spec) => ({ ...spec, forms: [{ entity: 'new_ticket', name: 'Ticket', fieldOptions: { new_ref: { readOnlyy: true } } }] });

test('verify CLI still verifies the deployment of a form whose fieldOptions entry carries a key it does not take — and warns, naming the key', async () => {
  const { reads, emitted, stderr } = await verifyOlderSpec(withTypoForm(appSpec({ columns: [column({ type: 'Text' })] })));
  const result = JSON.parse(JSON.stringify(emitted.payload));
  assert.ok(Number.isInteger(result.total) && result.total > 0 && Array.isArray(result.missing), `a verdict, not a refusal: ${JSON.stringify(result)}`);
  assert.ok(reads.includes('columns new_ticket'), `the deployed columns were read: ${JSON.stringify(reads)}`);
  assert.match(stderr, /^ {2}[✓✗] form: Ticket/m, 'the form was looked for in the deployment');
  assert.ok(stderr.includes(`WARNING: ${FIELD_OPTION_TYPO}\n`), stderr);
  assert.deepStrictEqual(result.warnings, [FIELD_OPTION_TYPO]);
  assert.ok(!result.errors.some((e) => /unknown key/.test(e)), JSON.stringify(result.errors));
});

test('verify CLI still refuses such a spec for any other problem — before any read — and the fieldOptions key is no part of the refusal', async () => {
  const spec = withTypoForm(appSpec({ columns: [column({ type: 'Text' }), column({ schemaName: 'new_bad', type: 'Nope' })] }));
  const { reads, emitted, stderr } = await verifyOlderSpec(spec);
  const result = JSON.parse(JSON.stringify(emitted.payload));
  assert.strictEqual(emitted.ok, false);
  assert.deepStrictEqual(result.errors, ["entity new_ticket: column new_bad has unknown type 'Nope'"]);
  assert.deepStrictEqual(result.warnings, [FIELD_OPTION_TYPO]);
  assert.ok(stderr.includes(`WARNING: ${FIELD_OPTION_TYPO}\n`), stderr);
  assert.deepStrictEqual(reads, [], 'nothing was read');
});

// --- a table whose primaryAttribute carries a key it does not take ---------------------------------------------------------------------
// The build, the lint and the provisioning gate refuse a key a table's `primaryAttribute` does not take; a release before that check accepted
// and ignored one. Verification passes primaryAttributeKeys: 'warn', as it passes fieldOptionKeys: 'warn': a warning that names the key and the
// key it most likely meant, and the verdict is the deployment's.
const PRIMARY_ATTRIBUTE_TYPO = "entity new_ticket: unknown key 'maxlength' on primaryAttribute — did you mean 'maxLength'? (allowed: schemaName, displayName, autoNumberFormat, required, maxLength)";

test('verify CLI still verifies the deployment of a table whose primaryAttribute carries a key it does not take — and warns, naming the key', async () => {
  const { reads, emitted, stderr } = await verifyOlderSpec(appSpec({ columns: [column({ type: 'Text' })], primaryAttribute: nameColumn({ maxlength: 200 }) }));
  const result = JSON.parse(JSON.stringify(emitted.payload));
  assert.strictEqual(emitted.ok, true, JSON.stringify(result));
  assert.ok(result.total > 0 && result.present === result.total, `the deployment was checked: ${JSON.stringify(result)}`);
  assert.ok(reads.includes('columns new_ticket'), `the deployed columns were read: ${JSON.stringify(reads)}`);
  assert.ok(stderr.includes(`WARNING: ${PRIMARY_ATTRIBUTE_TYPO}\n`), stderr);
  assert.deepStrictEqual(result.warnings, [PRIMARY_ATTRIBUTE_TYPO]);
});

// --- the result JSON carries what stderr warns -----------------------------------------------------------------------------------------
// A person reads the `WARNING:` lines verify prints, but a caller that reads only the JSON result — a skill, a pipeline — lost them. The result's optional
// `warnings` array holds the same messages, without the prefix and in the order they were printed, and is left out when there is none, as `unverified` is.
// The result is compared as the process prints it (a JSON round trip): the CLI runs in a context of its own, whose arrays are not this one's.
const printedWarnings = (stderr) => stderr.split('\n').filter((line) => line.startsWith('WARNING: ')).map((line) => line.slice('WARNING: '.length));
const resultOf = (emitted) => JSON.parse(JSON.stringify(emitted.payload));
const AUTONUMBER_WARNING = 'entity new_ticket: column new_ref is an AutoNumber column but its autoNumberFormat is missing — give it a format such as "C-{SEQNUM:5}", or use type "Text" for a plain text column';

test('verify CLI puts the warning it prints for an older spec into the result JSON, and moves no other field', async () => {
  for (const [label, parts, finding] of OLDER_SPECS) {
    const { emitted, stderr } = await verifyOlderSpec(appSpec(parts));
    const result = resultOf(emitted);
    assert.strictEqual(emitted.ok, true, `${label}: ${JSON.stringify(result)}`);
    assert.deepStrictEqual(result.warnings, [`entity new_ticket: ${finding}`], `${label}: the result carries the warning, naming the column and the fix`);
    assert.deepStrictEqual(result.warnings, printedWarnings(stderr), `${label}: it is the very line stderr printed`);
    assert.ok(stderr.includes(`WARNING: entity new_ticket: ${finding}\n`), `${label}: and stderr keeps its line`);
    assert.deepStrictEqual(result, { ok: true, present: result.total, total: result.total, missing: [], errors: [], warnings: result.warnings }, `${label}: no other field moved`);
  }
});

test('verify CLI lists every warning of an older spec in the result, in the order of the lines on stderr', async () => {
  const spec = appSpec({
    columns: [column({ type: 'AutoNumber', required: 'true' }), column({ schemaName: 'new_status', type: 'Text', required: null })],
    primaryAttribute: nameColumn({ required: 'ApplicationRequired' }),
  });
  const { emitted, stderr } = await verifyOlderSpec(spec);
  const printed = printedWarnings(stderr);
  assert.strictEqual(printed.length, 4, stderr);
  assert.deepStrictEqual(resultOf(emitted).warnings, printed);
});

test('verify CLI leaves `warnings` out of the result when it warned of nothing — the result is what it always was', async () => {
  const spec = appSpec({ columns: [column({ type: 'AutoNumber', autoNumberFormat: 'C-{SEQNUM:5}', required: 'recommended' })], primaryAttribute: nameColumn({ required: false }) });
  const { emitted, stderr } = await verifyOlderSpec(spec);
  const result = resultOf(emitted);
  assert.ok(!/WARNING:/.test(stderr), stderr);
  assert.ok(!('warnings' in result), JSON.stringify(result));
  assert.deepStrictEqual(result, { ok: true, present: result.total, total: result.total, missing: [], errors: [] });
});

test('verify CLI that fails for another reason still carries its warnings — the colliding spec names the holder in `missing` and the collision in `warnings`', async () => {
  const { stderr, emitted } = await verifyCollidingSpec();
  const result = resultOf(emitted);
  assert.strictEqual(emitted.ok, false);
  assert.ok(result.missing.some((m) => /not as the declared N:N/.test(m)), JSON.stringify(result));
  assert.deepStrictEqual(result.errors, result.missing, '`errors` is still the alias of `missing`');
  assert.strictEqual(result.warnings.length, 1, JSON.stringify(result.warnings));
  assert.match(result.warnings[0], /both use the schema name 'contoso_project_contoso_task'/);
  assert.deepStrictEqual(result.warnings, printedWarnings(stderr));
});

test('a failing verdict carries the warnings beside the fields it always had', async () => {
  const missing = { kind: 'view', name: 'new_ticket.Open Tickets', present: false };
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: SPEC_FLAGS },
    validateResult: { ok: true, warnings: ['first warning', 'second warning'] },
    verifyResult: { ok: false, checks: [{ kind: 'entity', name: 'new_ticket', present: true }, missing], missing: [missing] },
  });
  await harness.main();
  const emitted = harness.events.find((e) => e.type === 'emitResult');
  assert.strictEqual(emitted.ok, false);
  assert.deepStrictEqual(resultOf(emitted), {
    ok: false, present: 1, total: 2, missing: ['view:new_ticket.Open Tickets'], errors: ['view:new_ticket.Open Tickets'], warnings: ['first warning', 'second warning'],
  });
  assert.ok(harness.stderr.join('').includes('WARNING: first warning\nWARNING: second warning\n'), 'stderr keeps its lines');
});

test('verify CLI reports `warnings` and `unverified` independently — each only when it has something to say', async () => {
  const unverified = ["form-labels:new_ticket.Ticket Main (the label of tab 'tab_overview' was not compared)"];
  const warnings = ['column new_ref needs a format'];
  const run = async (specWarnings, notDecided) => {
    const harness = loadVerifyCli({
      parseResult: { positional: [], flags: SPEC_FLAGS },
      validateResult: { ok: true, warnings: specWarnings },
      verifyResult: { ok: true, checks: [{ kind: 'entity', name: 'new_ticket', present: true }], missing: [], ...(notDecided ? { unverified: notDecided } : {}) },
    });
    await harness.main();
    return resultOf(harness.events.find((e) => e.type === 'emitResult'));
  };
  const base = { ok: true, present: 1, total: 1, missing: [], errors: [] };
  assert.deepStrictEqual(await run(warnings, unverified), { ...base, unverified, warnings });
  assert.deepStrictEqual(await run(warnings, null), { ...base, warnings });
  assert.deepStrictEqual(await run([], unverified), { ...base, unverified });
  assert.deepStrictEqual(await run(undefined, null), base, 'a validation that reports no list of warnings at all is no warning');
});

test('verify CLI puts the page workspace warning into the result JSON, after the spec\'s own', async () => {
  const left = 'C:\\temp\\genpage-x1y2z3';
  const stuck = `the page workspace could not be removed, so page source may be left on disk: ${left} — delete the folder by hand`;
  const disposeOutcome = { left: [left] };

  const alone = await verifyOlderSpec(appSpec({ columns: [column({ type: 'Text' })] }), { disposeOutcome });
  const aloneResult = resultOf(alone.emitted);
  assert.deepStrictEqual(aloneResult.warnings, [stuck], 'the run succeeded, with a page workspace left on disk');
  assert.strictEqual(alone.emitted.ok, true, 'it does not fail the run');
  assert.deepStrictEqual(printedWarnings(alone.stderr), [stuck], 'stderr says the same');
  assert.deepStrictEqual(aloneResult, { ok: true, present: aloneResult.total, total: aloneResult.total, missing: [], errors: [], warnings: [stuck] });

  const both = await verifyOlderSpec(appSpec({ columns: [column({ type: 'AutoNumber' })] }), { disposeOutcome });
  assert.deepStrictEqual(resultOf(both.emitted).warnings, [AUTONUMBER_WARNING, stuck], 'the spec\'s warning was found first, and the workspace is known last');
  assert.deepStrictEqual(printedWarnings(both.stderr), [AUTONUMBER_WARNING, stuck], 'in the order stderr printed them');

  const clean = await verifyOlderSpec(appSpec({ columns: [column({ type: 'Text' })] }), { disposeOutcome: { left: [] } });
  assert.ok(!('warnings' in resultOf(clean.emitted)), 'nothing left on disk, nothing to warn of');
});

test('verify CLI refuses an invalid spec with the warnings it found beside the errors, and prints them too', async () => {
  const spec = appSpec({ columns: [column({ type: 'AutoNumber' }), column({ schemaName: 'new_bad', type: 'Nope' })] });
  const { reads, emitted, stderr } = await verifyOlderSpec(spec);
  assert.strictEqual(emitted.ok, false);
  assert.deepStrictEqual(resultOf(emitted), { ok: false, errors: ["entity new_ticket: column new_bad has unknown type 'Nope'"], warnings: [AUTONUMBER_WARNING] });
  assert.deepStrictEqual(printedWarnings(stderr), [AUTONUMBER_WARNING], 'the refusal prints what the result carries');
  assert.deepStrictEqual(reads, [], 'nothing was read');
});

test('verify CLI refuses an invalid spec that has nothing to warn of with the result it always had, and prints no warning', async () => {
  const spec = appSpec({ columns: [column({ schemaName: 'new_bad', type: 'Nope' })] });
  const { reads, emitted, stderr } = await verifyOlderSpec(spec);
  assert.strictEqual(emitted.ok, false);
  assert.deepStrictEqual(resultOf(emitted), { ok: false, errors: ["entity new_ticket: column new_bad has unknown type 'Nope'"] });
  assert.ok(!/WARNING:/.test(stderr), stderr);
  assert.deepStrictEqual(reads, []);
});

test('verify CLI that stops on an unexpected error still prints its warnings on stderr, and prints no JSON — as before', async () => {
  const harness = loadVerifyCli({
    parseResult: { positional: [], flags: SPEC_FLAGS },
    validateResult: { ok: true, warnings: ['a spec warning'] },
    sdkThrows: new Error('SDK unavailable'),
    invokeAsMain: true,
  });
  await harness.settle();
  const emitted = harness.events.find((e) => e.type === 'emitResult');
  assert.strictEqual(emitted.ok, false);
  assert.match(emitted.payload.message, /SDK unavailable/);
  assert.ok(!('warnings' in emitted.payload), 'the failure is the error itself: there is no JSON result to add the field to');
  assert.ok(harness.stderr.join('').includes('WARNING: a spec warning\n'), 'the line a person reads is still printed');
});

// --- the script as a process: what a caller that reads only stdout gets, what a person reads on stderr, and the exit status ---------------------------------------
// stdout comes back as the bytes the process wrote, because the console that captures it decodes them with a code page of its own (Windows PowerShell 5.1 reads a child's stdout as
// OEM text); stderr as text. The spec is a file the run makes and removes. A refused spec needs no environment; `fake` (FAKE_VERIFY, helpers/fake-verify-preload.js) lets a
// verification complete without one — the real script, validation, throwaway workspace and printer over a fake verification.
const FAKE_VERIFY_PRELOAD = path.join(__dirname, 'helpers', 'fake-verify-preload.js');
function runVerifyProcess(spec, fake) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-process-'));
  try {
    const specPath = path.join(dir, 'app-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const run = spawnSync(process.execPath, [
      ...(fake ? ['--require', FAKE_VERIFY_PRELOAD] : []),
      path.join(__dirname, '..', 'verify-model-app.js'), '--env', 'https://contoso.crm.dynamics.com', '--spec', `@${specPath}`,
    ], {
      timeout: 60000,
      env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', ...(fake ? { FAKE_VERIFY: JSON.stringify(fake) } : {}) },
    });
    if (run.error) throw run.error;
    return { status: run.status, stdout: run.stdout, stderr: run.stderr.toString('utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('verify-model-app as a process prints the warnings in the JSON of a refused spec, the same lines on stderr, and exits 1', () => {
  const run = runVerifyProcess(appSpec({ columns: [column({ type: 'AutoNumber' }), column({ schemaName: 'new_bad', type: 'Nope' })] }));
  assert.strictEqual(run.status, 1, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout.toString('utf8')), {
    ok: false,
    errors: ["entity new_ticket: column new_bad has unknown type 'Nope'"],
    warnings: [AUTONUMBER_WARNING],
  });
  assert.deepStrictEqual(printedWarnings(run.stderr), [AUTONUMBER_WARNING]);
});

// --- the JSON result is pure ASCII ------------------------------------------------------------------------------------------------------------------------------------
// An agent reads verify's stdout off a console, and Windows PowerShell 5.1 decodes a child's stdout with the OEM code page: the UTF-8 bytes of an em dash arrive as three other
// characters, and a Japanese form name or a Spanish label as others still — in a warning that names them, in a `missing` entry, anywhere. Every character above U+007E is a
// `\uXXXX` escape instead (`emitResult`'s `ascii` option, as in the scripts an agent already reads off a console): the same JSON to any parser, and nothing a code page can garble.
// stderr is for people and is not escaped.
const JAPANESE_FORM = '\u65e5\u5831';
const FORM_WARNING = `form '${JAPANESE_FORM}': prune: false has no effect on an auto layout \u2014 an auto layout is already additive and never removes a field`;
// An AutoNumber column with no format (an em dash in its warning) and a form with a Japanese name that asks for an effect an auto layout cannot have (the name in its warning).
const nonAsciiSpec = (moreColumns = []) => ({
  ...appSpec({ columns: [column({ type: 'AutoNumber' }), ...moreColumns] }),
  forms: [{ entity: 'new_ticket', name: JAPANESE_FORM, layout: 'auto', prune: false, notes: false }],
});
const isAscii = (bytes) => bytes.every((byte) => byte < 0x80);

test('verify CLI asks emitResult for pure ASCII on every JSON result it prints — a passed verdict, a failed one and a refused spec', async () => {
  const missing = { kind: 'view', name: 'new_ticket.Open Tickets', present: false };
  const run = async (options) => {
    const harness = loadVerifyCli({ parseResult: { positional: [], flags: SPEC_FLAGS }, ...options });
    await harness.main();
    return harness.events.find((e) => e.type === 'emitResult');
  };
  const passed = await run({});
  assert.strictEqual(passed.ok, true);
  assert.ok(passed.options && passed.options.ascii === true, 'a passed verdict');
  const failed = await run({ verifyResult: { ok: false, checks: [{ kind: 'entity', name: 'new_ticket', present: true }, missing], missing: [missing] } });
  assert.strictEqual(failed.ok, false);
  assert.ok(failed.options && failed.options.ascii === true, 'a failed verdict');
  const refused = await run({ validateResult: { ok: false, errors: ['entities must be a non-empty array'] } });
  assert.strictEqual(refused.ok, false);
  assert.ok(refused.options && refused.options.ascii === true, 'a refused spec');
});

test('verify-model-app as a process prints the JSON of a refused spec as pure ASCII that reads back as the original text, and leaves stderr as it was written', () => {
  const run = runVerifyProcess(nonAsciiSpec([column({ schemaName: 'new_bad', type: 'Nop\u00e9' })]));
  assert.strictEqual(run.status, 1, run.stderr);
  assert.ok(isAscii(run.stdout), `every byte of stdout is ASCII: ${run.stdout.toString('utf8')}`);
  const asText = run.stdout.toString('latin1');
  assert.strictEqual(asText, run.stdout.toString('utf8'), 'so the code page that decodes it does not matter');
  assert.ok(asText.includes('\\u2014') && asText.includes('\\u65e5\\u5831') && asText.includes('\\u00e9'), 'a character beyond ASCII is an escape, not itself');
  assert.deepStrictEqual(JSON.parse(asText), {
    ok: false,
    errors: ["entity new_ticket: column new_bad has unknown type 'Nop\u00e9'"],
    warnings: [AUTONUMBER_WARNING, FORM_WARNING],
  });
  assert.deepStrictEqual(printedWarnings(run.stderr), [AUTONUMBER_WARNING, FORM_WARNING], 'the lines a person reads carry the characters themselves');
});

test('verify-model-app as a process prints the JSON of a completed verification as pure ASCII — a warning, a missing check, an unverified one and a page workspace with Spanish, Japanese and em-dash text read back as themselves', () => {
  const left = 'C:\\Users\\Jos\u00e9\\AppData\\Local\\Temp\\genpage-x1y2z3';
  const absent = { kind: 'form-labels', name: 'new_ticket.Principal', detail: 'la etiqueta de la pesta\u00f1a "Descripci\u00f3n" no est\u00e1 \u2014 \u65e5\u5831' };
  const unverified = ['form-labels:new_ticket.Ventas (la etiqueta "Cr\u00e9dito" no se compar\u00f3)'];
  const warnings = [AUTONUMBER_WARNING, FORM_WARNING, `the page workspace could not be removed, so page source may be left on disk: ${left} \u2014 delete the folder by hand`];
  for (const ok of [true, false]) {
    const checks = [{ kind: 'entity', name: 'new_ticket', present: true }, ...(ok ? [] : [{ ...absent, present: false }])];
    const run = runVerifyProcess(nonAsciiSpec(), { result: { ok, checks, missing: ok ? [] : [absent], unverified }, left: [left] });
    assert.strictEqual(run.status, ok ? 0 : 1, `ok=${ok}: ${run.stderr}`);
    assert.ok(isAscii(run.stdout), `ok=${ok}: every byte of stdout is ASCII: ${run.stdout.toString('utf8')}`);
    const asText = run.stdout.toString('latin1');
    assert.strictEqual(asText, run.stdout.toString('utf8'), `ok=${ok}: so the code page that decodes it does not matter`);
    const escapes = ['\\u2014', '\\u65e5\\u5831', '\\u00e9', ...(ok ? [] : ['\\u00f1'])];
    assert.ok(escapes.every((escape) => asText.includes(escape)), `ok=${ok}: a character beyond ASCII is an escape, not itself: ${asText}`);
    const missing = ok ? [] : ['form-labels:new_ticket.Principal (la etiqueta de la pesta\u00f1a "Descripci\u00f3n" no est\u00e1 \u2014 \u65e5\u5831)'];
    assert.deepStrictEqual(JSON.parse(asText), { ok, present: 1, total: ok ? 1 : 2, missing, errors: missing, unverified, warnings }, `ok=${ok}: the same document, decoded`);
    assert.deepStrictEqual(printedWarnings(run.stderr), warnings, `ok=${ok}: stderr carries the characters themselves`);
    assert.ok(run.stderr.includes(`  \u2298 ${unverified[0]}\n`), `ok=${ok}: and so does the unverified line`);
  }
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

// ── entityPrivileges reader ──────────────────────────────────────────────────────────────────────
// These tests exist because the original role-privileges tests injected a FAKE `entityPrivileges`
// into verifySpec, which meant the real reader was never executed by any test. That is how it shipped
// building a RELATIVE url against a transport that requires absolute ones — a failure verify-spec
// catches per entity, so every entity would silently have reported "privileges unreadable". A reader
// is only as tested as its narrowest untested seam, which is why the last test here drives the REAL
// vendored bundle rather than a hand-written SDK stub.
//
// The reader now goes through the SDK's `getEntityPrivileges` instead of a raw Web API call, so the
// url-shape tests that used to live here are gone with the url they tested. What replaces them is the
// SHAPE ADAPTATION and the fail-closed behaviour, which is what verify-spec actually depends on.

test('entityPrivileges maps the SDK camelCase rows onto the PascalCase shape the comparison reads', async () => {
  // lib/role-privileges.js speaks Dataverse's wire vocabulary (`PrivilegeType`), which is also what
  // the role WRITE payload uses. The SDK returns its own camelCase view. If this mapping were
  // dropped, `ACCESS_TYPE[...] === x.PrivilegeType` would compare against undefined for every row and
  // report every declared privilege as missing — a total, silent false failure.
  const seen = [];
  const sdk = stubSdk();
  sdk.getEntityPrivileges = async (logical) => {
    seen.push(logical);
    return [{ name: 'prvReadAccount', privilegeId: 'p1', privilegeType: 'Read', access: 'read', scopes: ['user', 'organization'] }];
  };
  const read = readerFor(sdk, 'app', {});

  const privs = await read.entityPrivileges('Account');

  assert.deepStrictEqual(seen, ['account'], 'the logical name is lower-cased, as Dataverse stores it');
  assert.deepStrictEqual(privs, [{ Name: 'prvReadAccount', PrivilegeId: 'p1', PrivilegeType: 'Read' }]);
});

test('entityPrivileges PROPAGATES a throw rather than returning an empty grant', async () => {
  // The SDK throws for a table that exposes no privileges (unknown or non-securable). Swallowing that
  // into `[]` would read as "this table exposes nothing", which passes the subset comparison
  // vacuously — the exact false PASS the check exists to prevent. verify-spec wraps each call in a
  // try/catch and leaves the entity ABSENT from its map, which `compareRolePrivileges` reports as a
  // finding. So the fail-closed behaviour depends on this throw reaching it.
  const sdk = stubSdk();
  sdk.getEntityPrivileges = async () => { throw new Error('no privileges for co_missing'); };
  const read = readerFor(sdk, 'app', {});
  await assert.rejects(read.entityPrivileges('co_missing'), /no privileges for co_missing/);
});

test('entityPrivileges is ALWAYS wired now that the SDK carries the read', async () => {
  // It used to be conditional on a raw httpClient + org url, and ABSENT when either was missing, so
  // verify-spec skipped the role-privileges check entirely. With the read on the SDK there is no such
  // condition left: the reader exists whenever the SDK does. Asserted so a future refactor cannot
  // quietly reintroduce a silent skip — an absent reader disables a security check without saying so.
  assert.strictEqual(typeof readerFor(stubSdk(), 'app', {}).entityPrivileges, 'function');
});

test('entityPrivileges REAL BUNDLE: the SDK method exists and returns the shape the mapping expects', async () => {
  // The seam that matters. A hand-written SDK stub proves only that the mapping is self-consistent;
  // it would stay green if `getEntityPrivileges` were renamed or dropped by a re-vendor, or if it
  // returned a different shape. Drive the actual bundle over a fake Dataverse instead.
  const { createMakerSdk, createNodeWorkspaceStorage } = require(path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entpriv-real-'));
  const urls = [];
  const httpClient = {
    get: async (url) => {
      urls.push(url);
      return {
        status: 200,
        headers: {},
        body: {
          LogicalName: 'co_ticket',
          Privileges: [
            { Name: 'prvReadco_ticket', PrivilegeId: 'p9', PrivilegeType: 'Read', CanBeBasic: true, CanBeGlobal: true },
            { Name: 'prvCreateco_ticket', PrivilegeId: 'p10', PrivilegeType: 'Create', CanBeBasic: false, CanBeGlobal: true },
          ],
        },
      };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: {}, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();

  const privs = await readerFor(sdk, 'app', {}).entityPrivileges('CO_Ticket');

  assert.deepStrictEqual(privs, [
    { Name: 'prvReadco_ticket', PrivilegeId: 'p9', PrivilegeType: 'Read' },
    { Name: 'prvCreateco_ticket', PrivilegeId: 'p10', PrivilegeType: 'Create' },
  ], 'the bundle must still return { name, privilegeId, privilegeType } rows');
  assert.ok(urls.some((u) => /EntityDefinitions\(LogicalName='co_ticket'\)/.test(u)),
    `the SDK must query the entity by logical name; saw ${JSON.stringify(urls)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rolePrivileges paginates and never caps with top', async () => {
  // Found by a LIVE run: with the previous 	op: 5000 a System Administrator role returned
  // EXACTLY 5000 rows -- silently truncated. Paginated it returns 7119, so 2119 privileges were
  // being dropped. A truncated page is the worst shape for this check: a declared privilege that
  // fell off the end reads as NOT HELD, so verify reports a correctly configured role as missing.
  // Dataverse honors  as a hard cap and omits @odata.nextLink, and the SDK rejects
  // paginate+top, so asserting the ABSENCE of top matters as much as the presence of paginate.
  const calls = [];
  const sdk = stubSdk();
  sdk.queryRecords = async (set, options) => { calls.push({ set, options }); return []; };
  const read = readerFor(sdk, 'app', {});

  await read.rolePrivileges('00000000-0000-0000-0000-000000000001');

  const q = calls.find((c) => c.set === 'roleprivileges');
  assert.ok(q, 'expected a roleprivileges query');
  assert.strictEqual(q.options.paginate, true, 'must follow @odata.nextLink to completion');
  assert.strictEqual('top' in q.options, false, 'must NOT cap with top -- Dataverse treats it as a hard cap and drops nextLink');
});

// ---------------------------------------------------------------------------
// appEntityComponents(): the app's TABLE (type-1) components.
//
// These drive the REAL reader through readerFor(), not a hand-fed fake handed to verify-spec — the
// consumer tests in verify-spec.test.js prove the CHECK, these prove the Dataverse plumbing it
// depends on (the componenttype filter, pagination, resolution direction and failure modes).
// ---------------------------------------------------------------------------

const META = { new_order: 'aaaa0000-0000-0000-0000-000000000001', new_line: 'aaaa0000-0000-0000-0000-000000000002', entity: 'eeee0000-0000-0000-0000-00000000000e' };

// `componentIds` are the type-1 rows the app carries. `calls` records every query/metadata read.
function componentsSdk({ componentIds = [], calls = [], resolve = META, noApp = false } = {}) {
  return {
    queryRecords: async (set, opts) => {
      calls.push({ set, opts });
      if (noApp) return [];
      if (set === 'appmodule') return [{ appmoduleid: 'app-uuid-1', appmoduleidunique: 'uid-1' }];
      if (set === 'appmodulecomponent') return componentIds.map((id) => ({ objectid: id, componenttype: 1 }));
      return [];
    },
    findTables: async () => [],
    findColumns: async () => [],
    dataverse: {
      get: async (url) => {
        calls.push({ url });
        const m = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
        const logical = m && m[1];
        if (typeof resolve === 'function') return resolve(logical);
        const id = resolve[logical];
        return id ? { status: 200, headers: {}, body: { MetadataId: id } } : { status: 404, headers: {}, body: null };
      },
    },
  };
}
const readerWith = (sdk) => readerFor(sdk, 'contoso_app', { workspaceDir: os.tmpdir() });

test('appEntityComponents(): filters componenttype 1 and PAGINATES rather than capping with top', async () => {
  // `top` is a HARD cap in Dataverse and suppresses @odata.nextLink, so a capped page truncates
  // silently — and for a MEMBERSHIP check a row that fell off the end reads as NOT PRESENT, i.e.
  // verify would report a correctly built app as broken. The same trap was already found live on
  // roleprivileges in this file. It would also hide the `entity` placeholder rows this check exists
  // to find, since those are exactly what accumulates in a corrupted app.
  const calls = [];
  const sdk = componentsSdk({ componentIds: [META.new_order], calls });
  await readerWith(sdk).appEntityComponents(['new_order']);
  const q = calls.find((c) => c.set === 'appmodulecomponent');
  assert.ok(q, 'the component query must run');
  assert.match(q.opts.filter, /componenttype eq 1/);
  assert.strictEqual(q.opts.paginate, true, 'must paginate to completion');
  assert.strictEqual(q.opts.top, undefined, 'must NOT cap with top — a truncated page reads as "missing"');
});

test('appEntityComponents(): reports present vs absent for the WANTED tables', async () => {
  const sdk = componentsSdk({ componentIds: [META.new_order] });
  const r = await readerWith(sdk).appEntityComponents(['new_order', 'new_line']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.present, ['new_order']);
  assert.strictEqual(r.placeholder, false);
});

test('appEntityComponents(): detects an `entity` placeholder component', async () => {
  const sdk = componentsSdk({ componentIds: [META.new_order, META.entity] });
  const r = await readerWith(sdk).appEntityComponents(['new_order']);
  assert.strictEqual(r.placeholder, true, 'a component pointing at the `entity` metadata table must be reported');
  assert.deepStrictEqual(r.present, ['new_order'], 'and the real table is still present');
});

test('appEntityComponents(): cost is bounded by the WANTED set, not by the component count', async () => {
  // Resolving every COMPONENT instead would scale with the app and reintroduce the need for a cap.
  const many = Array.from({ length: 300 }, (_, i) => `bbbb0000-0000-0000-0000-${String(i).padStart(12, '0')}`);
  const calls = [];
  const sdk = componentsSdk({ componentIds: many.concat(META.new_order), calls });
  const r = await readerWith(sdk).appEntityComponents(['new_order']);
  const metadataReads = calls.filter((c) => c.url).length;
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.present, ['new_order']);
  // one per wanted table + one for the `entity` placeholder probe
  assert.strictEqual(metadataReads, 2, `expected 2 metadata reads for 301 components, got ${metadataReads}`);
});

test('appEntityComponents(): a wanted table that does not exist is ABSENT, not a read failure', async () => {
  // A 404 means the table is not in the environment at all, which the separate entity-existence
  // check already reports. Failing the whole answer would mask it behind an unrelated error.
  const sdk = componentsSdk({ componentIds: [META.new_order] });
  const r = await readerWith(sdk).appEntityComponents(['new_order', 'new_ghost']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.present, ['new_order']);
});

test('appEntityComponents(): a non-404 resolution error fails closed and names the TABLE, not a GUID', async () => {
  const sdk = componentsSdk({ componentIds: [META.new_order], resolve: (logical) => (logical === 'new_line' ? { status: 403, headers: {}, body: null } : { status: 200, headers: {}, body: { MetadataId: META[logical] } }) });
  const r = await readerWith(sdk).appEntityComponents(['new_order', 'new_line']);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /new_line/, 'the reason must name the table so an operator can act on it');
  assert.match(r.reason, /403/);
});

test('appEntityComponents(): an unresolvable app fails closed', async () => {
  const r = await readerWith(componentsSdk({ noApp: true })).appEntityComponents(['new_order']);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /contoso_app/);
});

test('appEntityComponents(): an app with NO table components answers ok with nothing present', async () => {
  // This is the reported defect itself (a sitemap naming tables the app does not contain), not a
  // read failure — and it cannot mask a permissions problem, because the sitemap is read from the
  // same appmodulecomponent table and would fail visibly first.
  const r = await readerWith(componentsSdk({ componentIds: [] })).appEntityComponents(['new_order']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.present, []);
});

test('appEntityComponents(): memoized per wanted-set — one live read per verify run', async () => {
  const calls = [];
  const reader = readerWith(componentsSdk({ componentIds: [META.new_order], calls }));
  await reader.appEntityComponents(['new_order']);
  await reader.appEntityComponents(['new_order']);
  assert.strictEqual(calls.filter((c) => c.set === 'appmodulecomponent').length, 1, 'the component query must not repeat');
});
test('appEntityComponents(): matches an objectid whose CASING differs from the resolved MetadataId', async () => {
  // Dataverse does not guarantee that a component `objectid` and the table's `MetadataId` come back
  // in the same casing, and a GUID is case-insensitive. Comparing raw strings would report a
  // correctly pinned table as MISSING — a false red build on a healthy app.
  const sdk = componentsSdk({ componentIds: [META.new_order.toUpperCase()] });
  const r = await readerWith(sdk).appEntityComponents(['new_order']);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.present, ['new_order'], 'an upper-cased objectid must still match');
});
// The dashboard oracle through the REAL reader seam: `dashboardComponents` is implemented here with
// the SDK's own deserializer (fetch, then read the artifact), so a stub-only test would prove nothing
// about the reader verify actually runs with.
// A dashboard the SDK returns no artifact for, or a component list that is not a list, is not "no tiles": verify
// reports it unverified. Converting it to an empty list passed the check having read nothing.
test('readerFor + verifySpec: a dashboard whose artifact cannot be read is unverified, never passed', async () => {
  for (const [what, art] of [['no artifact', null], ['a malformed component list', { components: { chart: 1 } }]]) {
    const sdk = {
      findTables: async () => [],
      findColumns: async () => [],
      queryRecords: async (set) => (set === 'systemform' ? [{ formid: 'dash-1', formxml: '<form/>' }] : []),
      listArtifacts: async () => [],
      dataverse: { get: async () => ({ status: 200, body: { formxml: '<form/>', '@odata.etag': 'W/"1"' } }) },
      fetchArtifact: async () => {},
      getArtifact: async () => art,
      fetchEntityMetadata: async () => ({ Relationships: [] }),
      resolveArtifact: async () => [],
      retrieveSetting: async () => null,
    };
    const spec = { solution: { publisherPrefix: 'new' }, app: { name: 'Support Desk', uniqueName: 'new_supportdesk' }, entities: [], appShell: { areas: [] },
      dashboards: [{ name: 'Ops', tiles: [{ type: 'chart', name: 'By Priority', entity: 'new_ticket', viewId: 'v', visualizationId: 'c' }] }] };
    const r = await verifySpec(spec, readerFor(sdk, 'new_supportdesk', {}));
    const chk = r.checks.find((c) => c.kind === 'dashboard');
    assert.strictEqual(chk.present, false, what);
    assert.match(chk.detail, new RegExp(`its tiles could not be read \\(the SDK returned ${what}`), what);
  }
});

// verify checks what users see: the PUBLISHED dashboard. The SDK's read is the unpublished draft, and verify runs
// in the build's workspace, whose copy can hold unpushed edits — so a fix saved but not published, or never
// pushed, passed while users still saw the broken dashboard. Either is now unverified. So is a draft saved and put
// back while the tiles were read: that leaves the FormXML as it was, but not the draft's token.
test('readerFor + verifySpec: a dashboard whose draft or workspace copy is not what is published is unverified', async () => {
  const spec = { solution: { publisherPrefix: 'new' }, app: { name: 'Support Desk', uniqueName: 'new_supportdesk' }, entities: [], appShell: { areas: [] },
    dashboards: [{ name: 'Ops', tiles: [{ type: 'chart', name: 'By Priority', entity: 'new_ticket', viewId: 'v', visualizationId: 'c' }] }] };
  const fetches = [];
  // `later` answers the reads made AFTER the fetch: the dashboard changing while it is being read. `laterVersion` is
  // the draft's token then: a draft saved and put back leaves the FormXML as it was, but not its token.
  const sdkWith = ({ draftXml = '<form/>', dirty = false, draftStatus = 200, later = null, version = 'W/"1"', laterVersion = null } = {}) => {
    let reads = 0;
    const xml = () => (later && reads > 2 ? later : '<form/>');
    return {
    findTables: async () => [],
    findColumns: async () => [],
    queryRecords: async (set, o) => {
      // The published row carries its own token, which a write to the draft does not move.
      if (set === 'systemform' && o && o.select && o.select.includes('formxml')) { reads += 1; return [{ formid: 'dash-1', formxml: xml(), '@odata.etag': 'W/"9"' }]; }
      if (set === 'systemform') return [{ formid: 'dash-1', formxml: '<form/>' }];
      if (set === 'savedqueryvisualization') return [{ primaryentitytypecode: 'new_ticket' }];
      if (set === 'savedquery') return [{ returnedtypecode: 'new_ticket' }];
      return [];
    },
    listArtifacts: async (type) => (type === 'dashboard' ? [{ type, id: 'dash-1', isDirty: dirty }] : []),
    dataverse: { get: async (url) => {
      assert.strictEqual(url, '/systemforms(dash-1)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml');
      reads += 1;
      const token = laterVersion && reads > 2 ? laterVersion : version;
      return { status: draftStatus, body: { formxml: later && reads > 2 ? later : draftXml, ...(token === null ? {} : { '@odata.etag': token }) } };
    } },
    fetchArtifact: async (type, id, o) => { fetches.push(o); },
    getArtifact: async () => ({ components: [{ type: 'chart', name: 'By Priority', parameters: {
      TargetEntityType: 'new_ticket', ViewId: '{11111111-1111-1111-1111-111111111111}', VisualizationId: '{22222222-2222-2222-2222-222222222222}' } }] }),
    fetchEntityMetadata: async () => ({ Relationships: [] }),
    resolveArtifact: async () => [],
    retrieveSetting: async () => null,
    };
  };
  const check = async (sdk) => (await verifySpec(spec, readerFor(sdk, 'new_supportdesk', {}))).checks.find((c) => c.kind === 'dashboard');
  for (const [what, opts, detail] of [
    ['an unpublished draft', { draftXml: '<form><changed/></form>' }, /dashboard dash-1 has changes that are not published — publish it, then verify/],
    ['a draft that cannot be read', { draftStatus: 503 }, /the draft of dashboard dash-1 could not be read \(HTTP 503\)/],
    ['a dashboard that changed while it was read', { later: '<form><changed/></form>' }, /dashboard dash-1 changed while it was being read — verify again/],
    ['a draft saved and put back while it was read', { laterVersion: 'W/"3"' }, /dashboard dash-1 changed while it was being read — verify again/],
    ['a draft read with no version', { version: null }, /the version of dashboard dash-1 could not be read/],
  ]) {
    const chk = await check(sdkWith(opts));
    assert.strictEqual(chk.present, false, what);
    assert.match(chk.detail, detail, what);
  }
  // CONTROL: published, with nothing pending — the tiles are read and checked.
  const ok = await check(sdkWith());
  assert.strictEqual(ok.present, true, ok.detail);
  // With an isolated reader the tiles come from IT — a throwaway workspace — and never from the build's copy, which
  // may hold unpushed edits (the main SDK here would answer cross-wired tiles and is never asked), and it is disposed.
  const main = sdkWith();
  main.fetchArtifact = async () => { throw new Error('the build workspace must not be read for tiles'); };
  main.getArtifact = async () => ({ components: [{ type: 'chart', name: 'By Priority', parameters: { TargetEntityType: 'new_customer' } }] });
  const iso = sdkWith();
  let disposed = 0;
  const isolated = await verifySpec(spec, readerFor(main, 'new_supportdesk', { isolatedReader: async () => ({ sdk: iso, dispose: () => { disposed += 1; } }) }));
  const chk = isolated.checks.find((c) => c.kind === 'dashboard');
  assert.strictEqual(chk.present, true, chk.detail);
  assert.strictEqual(disposed, 1, 'the throwaway workspace is disposed after the read');
});

// ── A dashboard's two layers in an organization with a second language ───────────────────────────────────────────────────────────
// Live, in an organization whose base language is 1033 and which has Spanish (3082) provisioned too, verify called a dashboard
// that nothing had written since its build created and published it "has changes that are not published", and failed the job
// whose surface it is with it. The two reads it compares answered, cell by cell:
//   published (a plain read of the systemform row)  <cell …><labels><label description="By Priority" languagecode="1033" /></labels><control …
//   saved (RetrieveUnpublished)                      <cell …><labels><label description="By Priority" languagecode="1033" /><label description="…" languagecode="3082" /></labels><control …
// and nothing else: without its four 3082 labels the saved read IS the published FormXML. These fixtures are that shape, with
// the ids and the names replaced.
const DASH_TILE_CLASS = '{E7A81278-8635-4D9E-8D4D-59480B391C5B}';
const dashId = (n) => `{aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}}`;
const DASH_VIEW_OPEN = '11111111-0000-4000-8000-000000000001';
const DASH_VIEW_CRITICAL = '11111111-0000-4000-8000-000000000002';
const DASH_VIEW_GOLD = '11111111-0000-4000-8000-000000000003';
const DASH_CHART_PRIORITY = '22222222-0000-4000-8000-000000000001';
const DASH_CHART_STATUS = '22222222-0000-4000-8000-000000000002';
const dashChartCell = (n, caption, table, view, chart) => `<cell id="${dashId(n)}" colspan="1" rowspan="1" showlabel="true"><labels><label description="${caption}" languagecode="1033" /></labels>`
  + `<control id="${dashId(n + 100)}" classid="${DASH_TILE_CLASS}"><parameters><TargetEntityType>${table}</TargetEntityType><ViewId>${view}</ViewId>`
  + `<VisualizationId>${chart}</VisualizationId><ChartGridMode>Chart</ChartGridMode></parameters></control></cell>`;
const dashListCell = (n, caption, table, view) => `<cell id="${dashId(n)}" colspan="1" rowspan="1" showlabel="true"><labels><label description="${caption}" languagecode="1033" /></labels>`
  + `<control id="${dashId(n + 100)}" classid="${DASH_TILE_CLASS}"><parameters><TargetEntityType>${table}</TargetEntityType><ViewId>${view}</ViewId>`
  + '<IsUserView>false</IsUserView><ChartGridMode>Grid</ChartGridMode><RecordsPerPage>10</RecordsPerPage></parameters></control></cell>';
const dashboardXml = (rows) => `<form><tabs><tab id="${dashId(90)}" name="General" showlabel="true" expanded="true" verticallayout="true"><labels><label description="" languagecode="1033" /></labels>`
  + `<columns><column width="100%"><sections><section id="${dashId(91)}" name="Section 1" showlabel="false" columns="2"><labels><label description="" languagecode="1033" /></labels><rows>`
  + rows.map((cells) => `<row>${cells.join('')}</row>`).join('')
  + '</rows></section></sections></column></columns></tab></tabs></form>';
const DASH_CELLS = {
  priority: dashChartCell(1, 'By Priority', 'new_workorder', DASH_VIEW_OPEN, DASH_CHART_PRIORITY),
  status: dashChartCell(2, 'By Status', 'new_workorder', DASH_VIEW_OPEN, DASH_CHART_STATUS),
  critical: dashListCell(3, 'Critical Queue', 'new_workorder', DASH_VIEW_CRITICAL),
  gold: dashListCell(4, 'Gold Customers', 'new_customer', DASH_VIEW_GOLD),
};
const PUBLISHED_DASHBOARD = dashboardXml([[DASH_CELLS.priority, DASH_CELLS.status], [DASH_CELLS.critical, DASH_CELLS.gold]]);
// The saved read of the same dashboard: a label in `lcid` after each cell's captions (live, the platform's 3082 one said the same for every cell).
// A cell is where a `</labels>` is followed by the tile's `<control>`.
const withCellCaptionsIn = (xml, lcid = 3082, text = 'Órdenes de trabajo') => xml.replace(/<\/labels><control /g, `<label description="${text}" languagecode="${lcid}" /></labels><control `);
// The tiles the SDK's deserializer reads out of it (the chart tiles are what the dashboard check proves).
const DASH_TILES = [
  { type: 'chart', name: 'By Priority', parameters: { TargetEntityType: 'new_workorder', ViewId: DASH_VIEW_OPEN, VisualizationId: DASH_CHART_PRIORITY } },
  { type: 'chart', name: 'By Status', parameters: { TargetEntityType: 'new_workorder', ViewId: DASH_VIEW_OPEN, VisualizationId: DASH_CHART_STATUS } },
  { type: 'list', name: 'Critical Queue', parameters: { TargetEntityType: 'new_workorder', ViewId: DASH_VIEW_CRITICAL } },
  { type: 'list', name: 'Gold Customers', parameters: { TargetEntityType: 'new_customer', ViewId: DASH_VIEW_GOLD } },
];
// The dashboard is the surface of a persona's job, as the live app's was, so a dashboard that fails takes the job with it.
const DASH_SPEC = { solution: { publisherPrefix: 'new' }, app: { name: 'Field Ops', uniqueName: 'new_fieldops' }, entities: [], appShell: { areas: [] },
  dashboards: [{ name: 'Field Ops Overview', tiles: [{ type: 'chart', name: 'By Priority', entity: 'new_workorder', viewId: 'v', visualizationId: 'c' }] }],
  personas: [{ persona: 'Dispatcher', jobs: [{ name: 'Watch the field', surfaces: ['Field Ops Overview'] }] }] };
// An SDK whose published read of the dashboard answers `published` and whose saved read answers `draft` — or, from the third read on
// (the bracket's second pair), `laterPublished` / `laterDraft` / `laterVersion` when given. `chartOwner` is the table a tile's chart
// belongs to. `owners` records each read of a tile's chart and view, which is the tile check running. `version` is the saved read's
// `@odata.etag`, and `publishedVersion` the published row's (a row that carries none, as in the reads above, when it is not given);
// `laterPublishedVersion` is the row's from the third read on.
function dashboardLayers({ published, draft, laterPublished, laterDraft, laterVersion, version = 'W/"1"', publishedVersion, laterPublishedVersion, chartOwner = 'new_workorder' }) {
  let reads = 0;
  const owners = [];
  const fetches = [];
  return {
    owners,
    fetches,
    findTables: async () => [],
    findColumns: async () => [],
    queryRecords: async (set, o) => {
      if (set === 'systemform' && o && o.select && o.select.includes('formxml')) {
        reads += 1;
        const token = reads > 2 && laterPublishedVersion !== undefined ? laterPublishedVersion : publishedVersion;
        return [{ formid: 'dash-1', formxml: laterPublished !== undefined && reads > 2 ? laterPublished : published, ...(token === undefined ? {} : { '@odata.etag': token }) }];
      }
      if (set === 'systemform') return [{ formid: 'dash-1', name: 'Field Ops Overview' }];
      if (set === 'savedqueryvisualization') { owners.push(set); return [{ primaryentitytypecode: chartOwner }]; }
      if (set === 'savedquery') { owners.push(set); return [{ returnedtypecode: 'new_workorder' }]; }
      return [];
    },
    listArtifacts: async () => [],
    dataverse: { get: async (url) => {
      assert.strictEqual(url, '/systemforms(dash-1)/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml');
      reads += 1;
      const later = reads > 2;
      return { status: 200, body: { formxml: later && laterDraft !== undefined ? laterDraft : draft, '@odata.etag': later && laterVersion ? laterVersion : version } };
    } },
    fetchArtifact: async (type, id) => { fetches.push([type, id]); },
    getArtifact: async () => ({ components: DASH_TILES }),
    fetchEntityMetadata: async () => ({ Relationships: [] }),
    resolveArtifact: async () => [],
    retrieveSetting: async () => null,
  };
}
const dashboardVerify = async (layers) => {
  const r = await verifySpec(DASH_SPEC, readerFor(dashboardLayers(layers), 'new_fieldops', {}));
  return { check: r.checks.find((c) => c.kind === 'dashboard'), jobs: r.checks.filter((c) => c.kind === 'job-surface') };
};
const NOT_PUBLISHED = /its tiles could not be read \(dashboard dash-1 has changes that are not published — publish it, then verify\) — unverified, not proven correct/;

test('readerFor + verifySpec: a published dashboard whose saved read carries a second language\u2019s captions too verifies — its tiles are checked, and its job passes with it', async () => {
  const draft = withCellCaptionsIn(PUBLISHED_DASHBOARD);
  assert.strictEqual(draft.split('languagecode="3082"').length - 1, 4, 'the live shape: a 3082 caption in each of the four cells');
  assert.strictEqual(draft.replace(/<label description="Órdenes de trabajo" languagecode="3082" \/>/g, ''), PUBLISHED_DASHBOARD, 'and nothing else');
  const sdk = dashboardLayers({ published: PUBLISHED_DASHBOARD, draft });
  const r = await verifySpec(DASH_SPEC, readerFor(sdk, 'new_fieldops', {}));
  const check = r.checks.find((c) => c.kind === 'dashboard');
  assert.deepStrictEqual([check.present, check.detail], [true, '']);
  assert.deepStrictEqual(sdk.fetches, [['dashboard', 'dash-1']], 'the tiles were read');
  assert.deepStrictEqual(sdk.owners, ['savedqueryvisualization', 'savedquery', 'savedqueryvisualization', 'savedquery'], 'and each chart tile\u2019s chart and view were checked');
  assert.deepStrictEqual(r.checks.filter((c) => c.kind === 'job-surface'), [], 'the job whose surface the dashboard is passes with it');
  // It is the tiles that decide: a chart tile cross-wired to another table still fails over the same two reads.
  const crossed = await dashboardVerify({ published: PUBLISHED_DASHBOARD, draft, chartOwner: 'new_customer' });
  assert.strictEqual(crossed.check.present, false);
  assert.match(crossed.check.detail, /chart tile 'By Priority' shows new_workorder, but its chart belongs to new_customer/);
  assert.match(crossed.jobs[0] && crossed.jobs[0].detail, /surface "Field Ops Overview" is not deployed \(Field Ops Overview\)/);
  // A language the published read does not carry is set aside whichever it is, and however many: a read in 1033 and 3082, a saved one with 1036 too.
  const bilingual = withCellCaptionsIn(PUBLISHED_DASHBOARD);
  const trilingual = await dashboardVerify({ published: bilingual, draft: withCellCaptionsIn(bilingual, 1036, 'Ordres de travail') });
  assert.deepStrictEqual([trilingual.check.present, trilingual.check.detail], [true, '']);
});

test('readerFor + verifySpec: a saved dashboard that differs from the published one in more than another language\u2019s captions is still not published', async () => {
  const changes = [
    ['a tile moved', dashboardXml([[DASH_CELLS.status, DASH_CELLS.priority], [DASH_CELLS.critical, DASH_CELLS.gold]])],
    ['a tile added', dashboardXml([[DASH_CELLS.priority, DASH_CELLS.status], [DASH_CELLS.critical, DASH_CELLS.gold], [dashChartCell(5, 'By Region', 'new_workorder', DASH_VIEW_OPEN, DASH_CHART_STATUS)]])],
    ['a tile removed', dashboardXml([[DASH_CELLS.priority, DASH_CELLS.status], [DASH_CELLS.critical]])],
    ['a caption changed in the base language', PUBLISHED_DASHBOARD.replace('description="By Priority" languagecode="1033"', 'description="By Owner" languagecode="1033"')],
    ['a base-language caption removed', PUBLISHED_DASHBOARD.replace('<label description="By Status" languagecode="1033" />', '')],
    ['an attribute changed', PUBLISHED_DASHBOARD.replace(`<cell id="${dashId(1)}" colspan="1"`, `<cell id="${dashId(1)}" colspan="2"`)],
    ['an attribute added', PUBLISHED_DASHBOARD.replace('name="Section 1" showlabel="false"', 'name="Section 1" showlabel="false" visible="false"')],
    ['a tile\u2019s view changed', PUBLISHED_DASHBOARD.replace(`<ViewId>${DASH_VIEW_CRITICAL}</ViewId>`, `<ViewId>${DASH_VIEW_GOLD}</ViewId>`)],
    ['a tile\u2019s table changed', PUBLISHED_DASHBOARD.replace('<TargetEntityType>new_customer</TargetEntityType>', '<TargetEntityType>new_workorder</TargetEntityType>')],
  ];
  for (const [what, saved] of changes) {
    assert.notStrictEqual(saved, PUBLISHED_DASHBOARD, what);
    // Each saved read also carries the second language, as live: it is the comparison without those captions that must still find the change.
    const { check, jobs } = await dashboardVerify({ published: PUBLISHED_DASHBOARD, draft: withCellCaptionsIn(saved) });
    assert.strictEqual(check.present, false, what);
    assert.match(check.detail, NOT_PUBLISHED, what);
    assert.strictEqual(jobs.length, 1, `${what}: the job fails with its dashboard`);
  }
});

test('readerFor + verifySpec: a caption changed in a language the published read carries is a change, however many languages it carries', async () => {
  const bilingual = withCellCaptionsIn(PUBLISHED_DASHBOARD);
  const once = (xml, from, to) => { const i = xml.indexOf(from); assert.ok(i >= 0, from); return xml.slice(0, i) + to + xml.slice(i + from.length); };
  for (const [what, draft] of [
    ['a 3082 caption', once(bilingual, 'description="Órdenes de trabajo" languagecode="3082"', 'description="Pedidos" languagecode="3082"')],
    ['a 3082 caption removed', once(bilingual, '<label description="Órdenes de trabajo" languagecode="3082" />', '')],
    ['a 1033 caption', once(bilingual, 'description="Critical Queue" languagecode="1033"', 'description="Urgent Queue" languagecode="1033"')],
  ]) {
    const { check } = await dashboardVerify({ published: bilingual, draft });
    assert.strictEqual(check.present, false, what);
    assert.match(check.detail, NOT_PUBLISHED, what);
  }
});

test('readerFor + verifySpec: a FormXML that is not one well-formed XML document, on either side, is refused as before — never passed', async () => {
  const draft = withCellCaptionsIn(PUBLISHED_DASHBOARD);
  const cutShort = PUBLISHED_DASHBOARD.slice(0, -'</form>'.length);
  for (const [what, published, saved] of [
    ['a saved read with a label left open', PUBLISHED_DASHBOARD, draft.replace('languagecode="3082" />', 'languagecode="3082">')],
    ['a saved read with a bare "&" in a caption of the other language', PUBLISHED_DASHBOARD, draft.replace('Órdenes de trabajo', 'Órdenes & trabajo')],
    ['a saved read with a second root element', PUBLISHED_DASHBOARD, `${draft}<form/>`],
    ['a published read cut short', cutShort, withCellCaptionsIn(cutShort)],
    ['a published read with a closing tag missing', PUBLISHED_DASHBOARD.replace('</rows>', ''), withCellCaptionsIn(PUBLISHED_DASHBOARD.replace('</rows>', ''))],
    ['a published read that is no XML', 'not xml', draft],
  ]) {
    const sdk = dashboardLayers({ published, draft: saved });
    const check = (await verifySpec(DASH_SPEC, readerFor(sdk, 'new_fieldops', {}))).checks.find((c) => c.kind === 'dashboard');
    assert.strictEqual(check.present, false, what);
    assert.match(check.detail, NOT_PUBLISHED, what);
    assert.deepStrictEqual(sdk.fetches, [], `${what}: no tile is read`);
  }
});

test('readerFor + verifySpec: on two layers in two languages, a dashboard that changes while its tiles are read is still caught', async () => {
  const draft = withCellCaptionsIn(PUBLISHED_DASHBOARD);
  const moved = dashboardXml([[DASH_CELLS.status, DASH_CELLS.priority], [DASH_CELLS.critical, DASH_CELLS.gold]]);
  for (const [what, later] of [
    ['published again with a tile moved', { laterPublished: moved, laterDraft: withCellCaptionsIn(moved) }],
    ['a draft saved and put back', { laterVersion: 'W/"3"' }],
  ]) {
    const { check } = await dashboardVerify({ published: PUBLISHED_DASHBOARD, draft, ...later });
    assert.strictEqual(check.present, false, what);
    assert.match(check.detail, /dashboard dash-1 changed while it was being read — verify again/, what);
  }
});

// The same two reads through the REAL bundle: the reader's own reads and the SDK's deserializer, over a stub of the HTTP client. What
// the reader hands verify is the tiles the SDK reads out of the saved layer. `publishedVersion` is the published row's `@odata.etag`
// when given (the row answers none otherwise) and `version` the saved layer's; `reads` is the order the stub was asked in.
async function readDashboardThroughRealBundle(t, id, published, draft, { publishedVersion, version = 'W/"7"' } = {}) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-dash-layers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reads = [];
  const ok = (body) => ({ status: 200, headers: {}, body });
  const httpClient = {
    get: async (url) => {
      const u = decodeURIComponent(url);
      if (/EntityDefinitions\(LogicalName='systemform'\)/.test(u)) return ok({ EntitySetName: 'systemforms' });
      if (u.includes(`/systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()?$select=formxml`) && !u.includes(',')) {
        reads.push('saved formxml');
        return ok({ formxml: draft, '@odata.etag': version });
      }
      if (u.includes(`/systemforms(${id})/Microsoft.Dynamics.CRM.RetrieveUnpublished()`)) {
        reads.push('the SDK\u2019s fetch');
        return ok({ formid: id, name: 'Field Ops Overview', description: null, formxml: draft, type: 0, objecttypecode: 'none', componentstate: 1, '@odata.etag': version });
      }
      if (/\/systemforms\?/.test(u) && u.includes(`formid eq ${id}`)) {
        reads.push('published formxml');
        return ok({ value: [{ ...(publishedVersion === undefined ? {} : { '@odata.etag': publishedVersion }), formid: id, formxml: published }] });
      }
      assert.fail(`unexpected GET ${u}`);
    },
    post: async (url) => assert.fail(`unexpected POST ${url}`),
    patch: async (url) => assert.fail(`unexpected PATCH ${url}`),
    put: async (url) => assert.fail(`unexpected PUT ${url}`),
    delete: async (url) => assert.fail(`unexpected DELETE ${url}`),
  };
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: 'https://contoso.crm.dynamics.com', httpClient });
  await sdk.initWorkspace();
  const settled = await readerFor(sdk, 'new_fieldops', {}).dashboardComponents(id).then((tiles) => ({ tiles }), (error) => ({ error }));
  return { ...settled, reads };
}

// Here the live shape of the first language pair: a 3082 caption in every cell of the saved read.
test('readerFor REAL BUNDLE: the tiles of a published dashboard whose saved read carries a second language are read, and a real change is refused', async (t) => {
  const id = '33333333-0000-4000-8000-000000000001';
  const run = (published, draft) => readDashboardThroughRealBundle(t, id, published, draft);
  const live = await run(PUBLISHED_DASHBOARD, withCellCaptionsIn(PUBLISHED_DASHBOARD));
  assert.ifError(live.error);
  assert.deepStrictEqual(live.tiles.map((c) => [c.type, c.name, c.parameters.TargetEntityType, c.parameters.ViewId, c.parameters.VisualizationId]), [
    ['chart', 'By Priority', 'new_workorder', DASH_VIEW_OPEN, DASH_CHART_PRIORITY],
    ['chart', 'By Status', 'new_workorder', DASH_VIEW_OPEN, DASH_CHART_STATUS],
    ['list', 'Critical Queue', 'new_workorder', DASH_VIEW_CRITICAL, undefined],
    ['list', 'Gold Customers', 'new_customer', DASH_VIEW_GOLD, undefined],
  ]);
  assert.deepStrictEqual(live.reads, ['published formxml', 'saved formxml', 'the SDK\u2019s fetch', 'published formxml', 'saved formxml'], 'the tiles are read between the two checks');
  // A tile moved in the saved layer, over the same second language: refused before the SDK reads anything.
  const moved = await run(PUBLISHED_DASHBOARD, withCellCaptionsIn(dashboardXml([[DASH_CELLS.status, DASH_CELLS.priority], [DASH_CELLS.critical, DASH_CELLS.gold]])));
  assert.match(moved.error && moved.error.message, /^dashboard 33333333-0000-4000-8000-000000000001 has changes that are not published — publish it, then verify$/);
  assert.deepStrictEqual(moved.reads, ['published formxml', 'saved formxml']);
});

// ── A dashboard read by a user whose own language is the organization's second one ───────────────────────────────────────────────
// Live, the published read of such a user carries both languages, the user's own first, and words one caption another way than the saved
// layer does — while the published row and the saved layer are at the very same version (`@odata.etag`) and nothing has written either.
// A read is the platform's projection for its reader, so the two texts cannot say whether the saved layer is the published row; the version
// can, and verify takes it for that (lib/formxml-layers.js) — for the captions alone: the tiles must still be the same. The reads are the live
// ones (helpers/dashboard-two-language-reads.js), the published row's version and the saved layer's the same token, or not.
const { BASE_LANGUAGE_USER, SECOND_LANGUAGE_USER, ROW_VERSION, MOVED_VERSION, cellOf, swapFirstTwoCells } = dashboardReads;
const AT_ROW_VERSION = { publishedVersion: ROW_VERSION, version: ROW_VERSION };
const AFTER_A_SAVE = { publishedVersion: ROW_VERSION, version: MOVED_VERSION };

test('readerFor + verifySpec: a published dashboard read by a user whose own language is the second one verifies — its tiles are checked, and its job passes with it', async () => {
  const { published, saved } = SECOND_LANGUAGE_USER;
  const sdk = dashboardLayers({ published, draft: saved, ...AT_ROW_VERSION });
  const r = await verifySpec(DASH_SPEC, readerFor(sdk, 'new_fieldops', {}));
  const check = r.checks.find((c) => c.kind === 'dashboard');
  assert.deepStrictEqual([check.present, check.detail], [true, '']);
  assert.deepStrictEqual(sdk.fetches, [['dashboard', 'dash-1']], 'the tiles were read');
  assert.deepStrictEqual(sdk.owners, ['savedqueryvisualization', 'savedquery', 'savedqueryvisualization', 'savedquery'], 'and each chart tile\u2019s chart and view were checked');
  assert.deepStrictEqual(r.checks.filter((c) => c.kind === 'job-surface'), [], 'the job whose surface the dashboard is passes with it');
  // It is still the tiles that decide: a chart tile cross-wired to another table fails over the same two reads.
  const crossed = await dashboardVerify({ published, draft: saved, ...AT_ROW_VERSION, chartOwner: 'new_customer' });
  assert.strictEqual(crossed.check.present, false);
  assert.match(crossed.check.detail, /chart tile 'By Priority' shows new_workorder, but its chart belongs to new_customer/);
  assert.match(crossed.jobs[0] && crossed.jobs[0].detail, /surface "Field Ops Overview" is not deployed \(Field Ops Overview\)/);
  // A published row that answers no version has no word to give: the two reads are compared by their text alone, as they were, and differ.
  const noVersion = await dashboardVerify({ published, draft: saved, version: ROW_VERSION });
  assert.strictEqual(noVersion.check.present, false);
  assert.match(noVersion.check.detail, NOT_PUBLISHED);
});

test('readerFor + verifySpec: a dashboard saved and not published after its publish is not published, for a user of either language', async () => {
  for (const [user, { published, saved }] of [['a base-language user', BASE_LANGUAGE_USER], ['a second-language user', SECOND_LANGUAGE_USER]]) {
    for (const [what, draft] of [
      ['a tile moved', swapFirstTwoCells(saved)],
      ['a tile\u2019s view changed', saved.replace(`<ViewId>${DASH_VIEW_CRITICAL}</ViewId>`, `<ViewId>${DASH_VIEW_GOLD}</ViewId>`)],
      ['a tile\u2019s table changed', saved.replace('<TargetEntityType>new_customer</TargetEntityType>', '<TargetEntityType>new_workorder</TargetEntityType>')],
      ['a 1033 caption changed', saved.replace('description="By Priority" languagecode="1033"', 'description="By Owner" languagecode="1033"')],
      ['a 1033 caption removed', saved.replace('<label description="By Status" languagecode="1033" />', '')],
    ]) {
      assert.notStrictEqual(draft, saved, `${user}: ${what}`);
      const sdk = dashboardLayers({ published, draft, ...AFTER_A_SAVE });
      const r = await verifySpec(DASH_SPEC, readerFor(sdk, 'new_fieldops', {}));
      const check = r.checks.find((c) => c.kind === 'dashboard');
      assert.strictEqual(check.present, false, `${user}: ${what}`);
      assert.match(check.detail, NOT_PUBLISHED, `${user}: ${what}`);
      assert.deepStrictEqual(sdk.fetches, [], `${user}: ${what}: no tile is read`);
      assert.strictEqual(r.checks.filter((c) => c.kind === 'job-surface').length, 1, `${user}: ${what}: the job fails with its dashboard`);
    }
  }
  // A second-language caption alone: the base-language user's published read carries none, so it is not seen (the documented limit, as since the
  // first fix); the second-language user's read carries them, so it is a change.
  const pedidos = (xml) => xml.replace('description="Work Orders" languagecode="3082"', 'description="Pedidos" languagecode="3082"');
  const base = await dashboardVerify({ published: BASE_LANGUAGE_USER.published, draft: pedidos(BASE_LANGUAGE_USER.saved), ...AFTER_A_SAVE });
  assert.deepStrictEqual([base.check.present, base.check.detail], [true, '']);
  const second = await dashboardVerify({ published: SECOND_LANGUAGE_USER.published, draft: pedidos(SECOND_LANGUAGE_USER.saved), ...AFTER_A_SAVE });
  assert.strictEqual(second.check.present, false);
  assert.match(second.check.detail, NOT_PUBLISHED);
});

test('readerFor + verifySpec: for a user of the base language the dashboard check is as it was, whatever versions the two reads carry', async () => {
  const { published, saved } = BASE_LANGUAGE_USER;
  for (const [what, versions] of [
    ['a published row that answers no version', {}],
    ['one version on both layers', AT_ROW_VERSION],
    ['a saved layer written since the publish, a second language\u2019s captions alone differing', AFTER_A_SAVE],
  ]) {
    const sdk = dashboardLayers({ published, draft: saved, ...versions });
    const r = await verifySpec(DASH_SPEC, readerFor(sdk, 'new_fieldops', {}));
    const check = r.checks.find((c) => c.kind === 'dashboard');
    assert.deepStrictEqual([check.present, check.detail], [true, ''], what);
    assert.deepStrictEqual(sdk.fetches, [['dashboard', 'dash-1']], `${what}: the tiles were read`);
  }
  // The published read of this user carries one language, so its caption in that language is the text rule's alone: a 1033 caption saved and not
  // published is a change whatever the two versions say.
  const renamed = saved.replace('description="By Priority" languagecode="1033"', 'description="By Owner" languagecode="1033"');
  for (const [what, versions] of [['no version', {}], ['one version on both layers', AT_ROW_VERSION], ['a saved layer written since the publish', AFTER_A_SAVE]]) {
    const { check } = await dashboardVerify({ published, draft: renamed, ...versions });
    assert.strictEqual(check.present, false, what);
    assert.match(check.detail, NOT_PUBLISHED, what);
  }
});

test('readerFor + verifySpec: the same version excuses captions only — a tile that differs between the two reads is not published, and no tile is read', async () => {
  const { published, saved } = SECOND_LANGUAGE_USER;
  for (const [what, draft] of [
    ['a tile moved', swapFirstTwoCells(saved)],
    ['a tile\u2019s view changed', saved.replace(`<ViewId>${DASH_VIEW_GOLD}</ViewId>`, `<ViewId>${DASH_VIEW_OPEN}</ViewId>`)],
    ['a cell removed', saved.replace(cellOf(saved, 4), '')],
  ]) {
    assert.notStrictEqual(draft, saved, what);
    const sdk = dashboardLayers({ published, draft, ...AT_ROW_VERSION });
    const check = (await verifySpec(DASH_SPEC, readerFor(sdk, 'new_fieldops', {}))).checks.find((c) => c.kind === 'dashboard');
    assert.strictEqual(check.present, false, what);
    assert.match(check.detail, NOT_PUBLISHED, what);
    assert.deepStrictEqual(sdk.fetches, [], `${what}: no tile is read`);
  }
});

test('readerFor + verifySpec: for a user of the second language, a dashboard that changes while its tiles are read is still caught', async () => {
  const { published, saved } = SECOND_LANGUAGE_USER;
  for (const [what, later, detail] of [
    // Moved and published again: both layers are at the new version, so the second check passes, and the published FormXML is not the first one.
    ['published again with a tile moved', { laterPublished: swapFirstTwoCells(published), laterDraft: swapFirstTwoCells(saved), laterPublishedVersion: MOVED_VERSION, laterVersion: MOVED_VERSION },
      /dashboard dash-1 changed while it was being read — verify again/],
    // A draft saved while the tiles were read moves the saved layer's version off the published row's: the second check no longer has its word.
    ['a draft saved while it was read', { laterVersion: MOVED_VERSION }, /dashboard dash-1 has changes that are not published — publish it, then verify/],
  ]) {
    const { check } = await dashboardVerify({ published, draft: saved, ...AT_ROW_VERSION, ...later });
    assert.strictEqual(check.present, false, what);
    assert.match(check.detail, detail, what);
  }
});

test('readerFor REAL BUNDLE: the tiles of a published dashboard are read for a user of the second language, and a saved change is refused', async (t) => {
  const id = '33333333-0000-4000-8000-000000000001';
  const { published, saved } = SECOND_LANGUAGE_USER;
  const live = await readDashboardThroughRealBundle(t, id, published, saved, { publishedVersion: ROW_VERSION, version: ROW_VERSION });
  assert.ifError(live.error);
  // The SDK reads the same tiles, with the same names, out of this saved read as out of the base-language user's.
  assert.deepStrictEqual(live.tiles.map((c) => [c.type, c.name, c.parameters.TargetEntityType, c.parameters.ViewId, c.parameters.VisualizationId]), [
    ['chart', 'By Priority', 'new_workorder', DASH_VIEW_OPEN, DASH_CHART_PRIORITY],
    ['chart', 'By Status', 'new_workorder', DASH_VIEW_OPEN, DASH_CHART_STATUS],
    ['list', 'Critical Queue', 'new_workorder', DASH_VIEW_CRITICAL, undefined],
    ['list', 'Gold Customers', 'new_customer', DASH_VIEW_GOLD, undefined],
  ]);
  assert.deepStrictEqual(live.reads, ['published formxml', 'saved formxml', 'the SDK\u2019s fetch', 'published formxml', 'saved formxml'], 'the tiles are read between the two checks');
  // A saved layer written since the publish — its version moved — is not the published row: refused before the SDK reads anything.
  const written = await readDashboardThroughRealBundle(t, id, published, saved, { publishedVersion: ROW_VERSION, version: MOVED_VERSION });
  assert.match(written.error && written.error.message, /^dashboard 33333333-0000-4000-8000-000000000001 has changes that are not published — publish it, then verify$/);
  assert.deepStrictEqual(written.reads, ['published formxml', 'saved formxml']);
  // So is one whose published row answers no version, as before: the two texts alone cannot say.
  const unversioned = await readDashboardThroughRealBundle(t, id, published, saved);
  assert.match(unversioned.error && unversioned.error.message, /^dashboard 33333333-0000-4000-8000-000000000001 has changes that are not published — publish it, then verify$/);
  // The base-language user's reads are read whether or not the row answers a version.
  for (const options of [{}, { publishedVersion: ROW_VERSION, version: ROW_VERSION }]) {
    const base = await readDashboardThroughRealBundle(t, id, BASE_LANGUAGE_USER.published, BASE_LANGUAGE_USER.saved, options);
    assert.ifError(base.error);
    assert.deepStrictEqual(base.tiles.map((c) => c.name), ['By Priority', 'By Status', 'Critical Queue', 'Gold Customers']);
  }
});

// A client per isolated read ran `az account get-access-token` once per dashboard. One client serves every read of a
// run — the run's own when it is given — while each read still gets a fresh SDK in its own throwaway workspace.
test('isolatedReaderFor shares one HTTP client across reads, each with a fresh SDK', async () => {
  const { isolatedReaderFor } = require('../verify-model-app.js');
  const client = { request: async () => { throw new Error('no request is made'); } };
  let made = 0;
  const makeClient = () => { made += 1; return client; };
  const read = isolatedReaderFor('https://contoso.crm.dynamics.com', { makeClient });
  const a = await read();
  const b = await read();
  assert.strictEqual(made, 1, 'one client for the run');
  assert.notStrictEqual(a.sdk, b.sdk, 'a fresh SDK per read');
  a.dispose();
  b.dispose();
  const own = await isolatedReaderFor('https://contoso.crm.dynamics.com', { httpClient: client, makeClient })();
  own.dispose();
  assert.strictEqual(made, 1, 'with the run\u2019s own client, none is made');
});

test('readerFor + verifySpec: a cross-wired dashboard chart tile fails verify through the real reader seam', async () => {
  const calls = [];
  const sdk = {
    findTables: async () => [],
    findColumns: async () => [],
    queryRecords: async (set, opts) => {
      if (set === 'systemform') return [{ formid: 'dash-1', formxml: '<form/>' }];
      if (set === 'savedqueryvisualization') return [{ primaryentitytypecode: 'new_customer' }];
      if (set === 'savedquery') return [{ returnedtypecode: 'new_ticket' }];
      return [];
    },
    listArtifacts: async () => [],
    dataverse: { get: async () => ({ status: 200, body: { formxml: '<form/>', '@odata.etag': 'W/"1"' } }) },
    fetchArtifact: async (type, id) => { calls.push(['fetchArtifact', type, id]); },
    getArtifact: async (type, id) => {
      calls.push(['getArtifact', type, id]);
      return { components: [{ type: 'chart', name: 'By Priority', parameters: {
        TargetEntityType: 'new_ticket', ViewId: '{11111111-1111-1111-1111-111111111111}', VisualizationId: '{22222222-2222-2222-2222-222222222222}' } }] };
    },
    fetchEntityMetadata: async () => ({ Relationships: [] }),
    resolveArtifact: async () => [],
    retrieveSetting: async () => null,
  };
  const spec = { solution: { publisherPrefix: 'new' }, app: { name: 'Support Desk', uniqueName: 'new_supportdesk' }, entities: [], appShell: { areas: [] },
    dashboards: [{ name: 'Ops', tiles: [{ type: 'chart', name: 'By Priority', entity: 'new_ticket', viewId: 'v', visualizationId: 'c' }] }] };
  const r = await verifySpec(spec, readerFor(sdk, 'new_supportdesk', {}));
  const chk = r.checks.find((c) => c.kind === 'dashboard');
  assert.ok(chk, 'a dashboard check must be produced');
  assert.strictEqual(chk.present, false);
  assert.match(chk.detail, /shows new_ticket, but its chart belongs to new_customer/);
  assert.deepStrictEqual(calls, [['fetchArtifact', 'dashboard', 'dash-1'], ['getArtifact', 'dashboard', 'dash-1']], 'the tiles come from the SDK artifact of THAT dashboard');
});

test('readerFor + verifySpec reads isdefault and formxml once per verify, and re-reads on the next', async () => {
  const calls = [];
  // The tab and the section carry the captions the spec declares, as the build writes them: verify holds a label the spec authors.
  const labels = '<labels><label description="Main" languagecode="1033" /></labels>';
  const xml = `<form><tabs><tab name="tab_main">${labels}<columns><column width="100%"><sections><section name="sec_main">${labels}<rows><row><cell><control datafieldname="contoso_name" /></cell></row></rows></section></sections></column></columns></tab></tabs></form>`;
  const sdk = {
    findTables: async () => [{ logicalName: 'contoso_task' }],
    findColumns: async () => [{ logicalName: 'contoso_name' }],
    queryRecords: async (set, opts) => {
      calls.push({ set, opts });
      if (set !== 'systemform') return [];
      if (opts && opts.filter && /name eq/.test(opts.filter)) return [{ formid: 'form-1' }];
      if (opts && opts.filter && /formid eq form-1/.test(opts.filter)) {
        return [{ formid: 'form-1', name: 'Main', objecttypecode: 'contoso_task', type: 2, isdefault: true, formxml: xml }];
      }
      return [];
    },
    dataverse: { get: async () => ({ status: 200, body: { value: [] } }) },
  };
  const spec = {
    solution: { uniqueName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Projects', uniqueName: 'contoso_projects' },
    entities: [{ schemaName: 'contoso_task', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
    views: [], charts: [], appShell: { areas: [] },
    forms: [{
      entity: 'contoso_task', name: 'Main', formType: 'Main', isDefault: true,
      tabs: [{ name: 'tab_main', label: 'Main', columns: [{ width: '100%', sections: [{ name: 'sec_main', label: 'Main', fields: ['contoso_name'] }] }] }],
    }],
  };
  const reader = readerFor(sdk, 'contoso_projects', {});
  const byId = () => calls.filter((c) => c.set === 'systemform' && c.opts && /formid eq /.test(c.opts.filter || ''));
  const first = await verifySpec(spec, reader);
  assert.ok(first.checks.some((c) => c.kind === 'form-default' && c.present), JSON.stringify(first.missing));
  assert.ok(first.checks.some((c) => c.kind === 'form-topology' && c.present), JSON.stringify(first.missing));
  assert.strictEqual(byId().length, 1, `default and layout must share one row read: ${JSON.stringify(byId())}`);
  assert.ok(byId()[0].opts.select.includes('isdefault') && byId()[0].opts.select.includes('formxml'));
  await verifySpec(spec, reader);
  assert.strictEqual(byId().length, 2, 'a second verify on the same reader must re-read the row');
});

test('readerFor memoizes findTables once per verify run', async () => {
  let calls = 0;
  const sdk = {
    findTables: async () => { calls += 1; return [{ logicalName: 'contoso_project' }, { logicalName: 'contoso_task' }, { logicalName: 'account' }]; },
    findColumns: async () => [],
    queryRecords: async () => [],
    dataverse: { get: async () => ({ status: 200, body: { value: [] } }) },
  };
  const reader = readerFor(sdk, 'contoso_app', {});
  assert.deepStrictEqual(await reader.findTable('CONTOSO_PROJECT'), { logicalName: 'contoso_project' });
  assert.deepStrictEqual(await reader.findTable('contoso_task'), { logicalName: 'contoso_task' });
  assert.strictEqual(await reader.findTable('missing'), null);
  assert.strictEqual(calls, 1, 'three findTable calls must share one catalog scan');
});

test('a reused reader sees a table created after the first verify pass', async () => {
  let tables = [];
  let scans = 0;
  const sdk = {
    findTables: async () => { scans += 1; return tables.slice(); },
    findColumns: async () => [],
    queryRecords: async () => [],
    dataverse: { get: async () => ({ status: 200, body: { value: [] } }) },
  };
  const spec = {
    solution: { publisherPrefix: 'contoso' },
    app: { name: 'Projects', uniqueName: 'contoso_projects' },
    entities: [{ schemaName: 'contoso_task', primaryAttribute: { schemaName: 'contoso_name' } }],
    views: [], charts: [], forms: [], appShell: { areas: [] },
  };
  const reader = readerFor(sdk, 'contoso_projects', {});
  const first = await verifySpec(spec, reader);
  assert.strictEqual(first.checks.find((c) => c.kind === 'entity').present, false);
  tables = [{ logicalName: 'contoso_task' }];
  const second = await verifySpec(spec, reader);
  assert.strictEqual(second.checks.find((c) => c.kind === 'entity').present, true, 'the catalog memo must not outlive one verify pass');
  assert.ok(scans >= 2);
});

test('a rejected catalog read does not poison the next verify pass', async () => {
  let fail = true;
  const sdk = {
    findTables: async () => {
      if (fail) throw new Error('catalog down');
      return [{ logicalName: 'contoso_task' }];
    },
    findColumns: async () => [],
    queryRecords: async () => [],
    dataverse: { get: async () => ({ status: 200, body: { value: [] } }) },
  };
  const spec = {
    solution: { publisherPrefix: 'contoso' },
    app: { name: 'Projects', uniqueName: 'contoso_projects' },
    entities: [{ schemaName: 'contoso_task', primaryAttribute: { schemaName: 'contoso_name' } }],
    views: [], charts: [], forms: [], appShell: { areas: [] },
  };
  const reader = readerFor(sdk, 'contoso_projects', {});
  await assert.rejects(() => verifySpec(spec, reader), /catalog down/);
  fail = false;
  const second = await verifySpec(spec, reader);
  assert.strictEqual(second.checks.find((c) => c.kind === 'entity').present, true);
});

test('readerFor + verifySpec names the 1:N that holds an N:N schema name', async () => {
  const sdk = {
    findTables: async () => [],
    findColumns: async () => [],
    queryRecords: async () => [],
    fetchEntityMetadata: async () => ({ Relationships: [] }),
    resolveArtifact: async () => [],
    retrieveSetting: async () => null,
    dataverse: {
      get: async (p) => {
        if (p.includes('RelationshipType')) {
          return { status: 200, body: { '@odata.type': '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName: 'contoso_project_contoso_task', RelationshipType: 'OneToManyRelationship' } };
        }
        if (p.includes('OneToManyRelationshipMetadata')) {
          return { status: 200, body: { SchemaName: 'contoso_project_contoso_task', ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task', ReferencingAttribute: 'contoso_projectid' } };
        }
        return { status: 200, body: { value: [] } };
      },
    },
  };
  const spec = {
    solution: { uniqueName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Projects', uniqueName: 'contoso_projects' },
    entities: [{ schemaName: 'contoso_project', primaryAttribute: { schemaName: 'contoso_name' } }],
    views: [], charts: [], forms: [], appShell: { areas: [] },
    relationships: [{ type: 'ManyToMany', entity1: 'contoso_project', entity2: 'contoso_task' }],
  };
  const r = await verifySpec(spec, readerFor(sdk, 'contoso_projects', {}));
  const rc = r.checks.find((c) => c.kind === 'relationship');
  assert.ok(rc, 'the real reader must check the relationship');
  assert.strictEqual(rc.present, false);
  assert.match(rc.detail, /exists as 1:N contoso_project -> contoso_task \(lookup contoso_projectid\), not as the declared N:N/);
});

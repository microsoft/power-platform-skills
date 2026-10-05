'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  main,
  makeDownloadSdk,
} = require('../download-model-app.js');
const { writeBaseline } = require('../lib/deployed-baseline.js');

const BUNDLE = path.resolve(__dirname, '..', 'vendor', 'cds-maker-sdk.cjs');
const APP_ID = '11111111-1111-1111-1111-111111111111';
const APP_UNIQUE_ID = '22222222-2222-2222-2222-222222222222';
const APP_UNIQUE = 'new_workspaceprobe';
const SITEMAP_ID = '33333333-3333-3333-3333-333333333333';
const TABLE_METADATA_ID = '44444444-4444-4444-4444-444444444444';
const ENV = 'https://contoso.crm.dynamics.com';

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function listRelativeFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs));
    }
  };
  walk(root);
  return out.sort();
}

function minimalSpec() {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'WorkspaceProbe', publisherPrefix: 'new' },
    app: { name: 'Workspace Probe', uniqueName: APP_UNIQUE },
    entities: [],
    pages: [],
    appShell: { areas: [] },
  };
}

function fakeMainDeps({ outDir, makeDownloadSdkImpl, runDownloadImpl, emitResults, stderr }) {
  const sdk = {
    queryRecords: async (logical, opts = {}) => {
      assert.strictEqual(logical, 'appmodule');
      const filter = opts.filter || '';
      if (/uniquename eq/.test(filter)) return [{ appmoduleid: APP_ID }];
      if (/appmoduleid eq/.test(filter)) return [{ uniquename: APP_UNIQUE }];
      return [];
    },
  };
  return {
    argv: ['--env', ENV, '--app', APP_UNIQUE, '--out', outDir],
    stderr: stderr || { write: () => {} },
    emitResult: (ok, payload) => emitResults.push({ ok, payload }),
    // The download only uses the verdict, so it must not pay the success-path `az account show`.
    preflightAuth: async (url, opts) => { assert.strictEqual(opts && opts.identityOnSuccess, false); return { ok: true }; },
    makeGenpageCli: () => ({ unused: true }),
    makeDownloadSdk: makeDownloadSdkImpl || (async () => ({ sdk, cleanup: () => {} })),
    runDownload: runDownloadImpl || (async ({ sdk: gotSdk, outDir: gotOutDir, appId, appUnique }) => {
      assert.strictEqual(gotSdk, sdk);
      assert.strictEqual(gotOutDir, outDir);
      assert.strictEqual(appId, APP_ID);
      assert.strictEqual(appUnique, APP_UNIQUE);
      return {
        ok: true,
        spec: minimalSpec(),
        pages: [],
        entities: [],
        webResources: [],
        droppedSubareas: 0,
        droppedSubareaDetails: [],
        dashboardWarnings: [],
      };
    }),
    validateAppSpec: () => ({ ok: true, warnings: [] }),
  };
}

// The real result printer ends the process (emitResult calls process.exit), so nothing after it runs:
// the throwaway workspace must be gone BEFORE the result is printed. A cleanup in a `finally` the
// printer never returned to used to leave one temp workspace behind per download. The fake printer
// here throws where the real one exits, so it cannot hide that the way a returning fake did.
test('the throwaway workspace is removed BEFORE the result is printed, since the real printer ends the process', async () => {
  for (const scenario of ['success', 'a download that fails', 'an app that cannot be resolved']) {
    const outDir = tmp('download-exit-');
    const tempWorkspace = tmp('model-app-download-exit-');
    const EXIT = new Error('process.exit');
    let existedAtPrint = null;
    let printed = 0;
    const deps = fakeMainDeps({
      outDir,
      emitResults: [],
      runDownloadImpl: scenario === 'a download that fails' ? async () => ({ ok: false, error: 'dashboard read failed' }) : undefined,
    });
    const cleanup = () => fs.rmSync(tempWorkspace, { recursive: true, force: true });
    const base = deps.makeDownloadSdk;
    deps.makeDownloadSdk = scenario === 'an app that cannot be resolved'
      ? async () => ({ sdk: { queryRecords: async () => [] }, cleanup })
      : async (...args) => ({ ...(await base(...args)), cleanup });
    let printedOk = null;
    deps.emitResult = (ok) => { printed += 1; printedOk = ok; existedAtPrint = fs.existsSync(tempWorkspace); throw EXIT; };
    await assert.rejects(main(deps), (e) => e === EXIT, scenario);
    assert.strictEqual(printed, 1, `${scenario}: the result is printed once`);
    assert.strictEqual(printedOk, scenario === 'success', `${scenario}: the printed outcome`);
    assert.strictEqual(existedAtPrint, false, `${scenario}: the temp workspace still existed when the result was printed`);
  }
});

test('makeDownloadSdk constructs the real bundle through its default import path, in a temp workspace it then removes', async () => {
  const made = await makeDownloadSdk(ENV, { httpClient: realBundleHttp({ etag: 'W/"1"', description: 'Server description' }) });
  try {
    assert.strictEqual((await made.sdk.fetchArtifact('app', APP_ID)).description, 'Server description');
    assert.ok(path.resolve(made.workspaceDir).startsWith(path.resolve(os.tmpdir())), `the workspace is a temp directory: ${made.workspaceDir}`);
    assert.ok(fs.existsSync(path.join(made.workspaceDir, 'manifest.json')), 'the SDK initialized the throwaway workspace');
  } finally {
    made.cleanup();
  }
  assert.ok(!fs.existsSync(made.workspaceDir), 'cleanup removes it');
});

test('constructs the download SDK on a temp workspace outside the output folder, never on the folder workspace', async () => {
  const outDir = tmp('download-out-');
  const constructed = [];
  const made = await makeDownloadSdk(ENV, {
    mkdtempSync: (prefix) => {
      assert.match(prefix, /model-app-download-$/);
      return tmp('model-app-download-');
    },
    createHttpClient: () => ({ get: async () => ({ status: 200, headers: {}, body: { value: [] } }) }),
    createNodeWorkspaceStorage: (workspaceDir) => {
      constructed.push(workspaceDir);
      return { workspaceDir };
    },
    createMakerSdk: ({ workspaceStorage }) => ({
      workspaceStorage,
      initWorkspace: async () => {},
    }),
  });
  try {
    assert.strictEqual(constructed.length, 1);
    assert.ok(!constructed[0].startsWith(outDir), `SDK workspace must be outside output folder: ${constructed[0]}`);
    assert.notStrictEqual(constructed[0], path.join(outDir, '.maker-workspace'));
    assert.ok(fs.existsSync(constructed[0]), 'temp workspace exists while the download SDK is in use');
  } finally {
    made.cleanup();
  }
  assert.ok(!fs.existsSync(constructed[0]), 'cleanup removes the temp workspace after a successful download');
});

test('removes the temp workspace when the download throws after SDK construction', async () => {
  const outDir = tmp('download-main-');
  const emitResults = [];
  const tempWorkspace = tmp('model-app-download-');
  let cleaned = false;
  const sdk = { queryRecords: async () => [{ appmoduleid: APP_ID, uniquename: APP_UNIQUE }] };
  await assert.rejects(
    main(fakeMainDeps({
      outDir,
      emitResults,
      makeDownloadSdkImpl: async () => ({
        sdk,
        workspaceDir: tempWorkspace,
        cleanup: () => {
          cleaned = true;
          fs.rmSync(tempWorkspace, { recursive: true, force: true });
        },
      }),
      runDownloadImpl: async () => { throw new Error('mid-download failure'); },
    })),
    /mid-download failure/
  );
  assert.strictEqual(cleaned, true);
  assert.ok(!fs.existsSync(tempWorkspace), 'temp workspace is removed even when a later download step throws');
  assert.deepStrictEqual(emitResults, [], 'unexpected throws still propagate to the CLI catch path');
});

test('CLI argument errors exit before creating any SDK workspace', async () => {
  for (const [argv, pattern] of [
    [['--env'], /--env requires a value/],
    [['--app', APP_UNIQUE], /^Usage:/],
  ]) {
    let exited = 0;
    let madeSdk = false;
    let text = '';
    await main({
      argv,
      stderr: { write: (s) => { text += s; } },
      exit: (code) => { exited = code; },
      preflightAuth: async () => { throw new Error('preflight should not run'); },
      makeDownloadSdk: async () => { madeSdk = true; },
    });
    assert.strictEqual(exited, 1);
    assert.match(text, pattern);
    assert.strictEqual(madeSdk, false);
  }
});

test('auth failure reports through emitResult before creating the download SDK', async () => {
  const outDir = tmp('download-auth-');
  const emitResults = [];
  let madeSdk = false;
  await main({
    argv: ['--env', ENV, '--app', APP_UNIQUE, '--out', outDir],
    stderr: { write: () => {} },
    emitResult: (ok, payload) => emitResults.push({ ok, payload }),
    preflightAuth: async () => ({ ok: false, error: 'not authorized' }),
    makeDownloadSdk: async () => { madeSdk = true; },
  });
  assert.deepStrictEqual(emitResults, [{ ok: false, payload: { ok: false, error: 'not authorized' } }]);
  assert.strictEqual(madeSdk, false);
});

test('CLI keeps existing messages for inconclusive auth, display-name resolution, lossy download, validation, and defaulted directEntry', async () => {
  async function runCase({ appArg = APP_UNIQUE, auth = { ok: true }, runDownloadImpl, validateAppSpec, allowLossy = false }) {
    const outDir = tmp('download-main-branches-');
    const emitResults = [];
    let text = '';
    const sdk = {
      queryRecords: async (logical, opts = {}) => {
        assert.strictEqual(logical, 'appmodule');
        const filter = opts.filter || '';
        if (/uniquename eq/.test(filter)) return appArg === APP_UNIQUE ? [{ appmoduleid: APP_ID }] : [];
        if (/name eq/.test(filter)) return [{ appmoduleid: APP_ID, uniquename: APP_UNIQUE, name: appArg }];
        if (/appmoduleid eq/.test(filter)) return [{ uniquename: APP_UNIQUE }];
        return [];
      },
    };
    await main({
      argv: ['--env', ENV, '--app', appArg, '--out', outDir, ...(allowLossy ? ['--allow-lossy-download'] : [])],
      stderr: { write: (s) => { text += s; } },
      emitResult: (ok, payload) => emitResults.push({ ok, payload }),
      preflightAuth: async () => auth,
      makeDownloadSdk: async () => ({ sdk, cleanup: () => {} }),
      makeGenpageCli: () => ({}),
      runDownload: runDownloadImpl,
      validateAppSpec: validateAppSpec || (() => ({ ok: true, warnings: [] })),
    });
    return { emitResults, text, outDir };
  }

  const lossyResult = {
    ok: true,
    spec: minimalSpec(),
    pages: [],
    entities: [],
    webResources: [],
    droppedSubareas: 1,
    droppedSubareaDetails: [{ type: 'DashBoard', id: 'dash-1', title: 'Operations' }],
    dashboardReconstructionError: 'dashboard read failed',
    dashboardWarnings: ['dashboard Operations could not be read'],
  };

  const inconclusiveDisplay = await runCase({
    appArg: 'Workspace Probe',
    auth: { ok: false, inconclusive: true, error: 'auth probe timed out' },
    runDownloadImpl: async () => ({ ...lossyResult, droppedSubareas: 0, dashboardReconstructionError: undefined, dashboardWarnings: [] }),
  });
  assert.match(inconclusiveDisplay.text, /auth probe timed out/);
  assert.match(inconclusiveDisplay.text, /resolved display name 'Workspace Probe' to app unique name 'new_workspaceprobe'/);
  assert.strictEqual(inconclusiveDisplay.emitResults[0].ok, true);

  const lossyBlocked = await runCase({ runDownloadImpl: async () => lossyResult });
  assert.match(lossyBlocked.text, /Pass --allow-lossy-download/);
  assert.match(lossyBlocked.text, / Cause: dashboard Operations could not be read\./, 'a per-dashboard reason is named');
  assert.strictEqual(lossyBlocked.emitResults[0].ok, false);
  assert.deepStrictEqual(lossyBlocked.emitResults[0].payload.dashboardWarnings, ['dashboard Operations could not be read']);

  // A subarea dropped with no per-dashboard reason: the message says what dropped and nothing it does
  // not know, and the payload carries no empty reason list.
  const lossyNoCause = await runCase({ runDownloadImpl: async () => ({ ...lossyResult, dashboardReconstructionError: undefined, dashboardWarnings: [] }) });
  assert.match(lossyNoCause.text, /ERROR: 1 sitemap subarea\(s\) could not be round-tripped: DashBoard:dash-1 \(Operations\)\. A rebuild from this spec will DROP them from the app nav\./);
  assert.doesNotMatch(lossyNoCause.text, /Cause:/);
  assert.strictEqual(lossyNoCause.emitResults[0].ok, false);
  assert.strictEqual('dashboardWarnings' in lossyNoCause.emitResults[0].payload, false);

  const lossyAllowed = await runCase({ allowLossy: true, runDownloadImpl: async () => lossyResult });
  assert.match(lossyAllowed.text, /WARNING: 1 sitemap subarea/);
  assert.strictEqual(lossyAllowed.emitResults[0].ok, true);

  const validationFailed = await runCase({
    runDownloadImpl: async () => ({ ...lossyResult, droppedSubareas: 0, dashboardReconstructionError: undefined, dashboardWarnings: [] }),
    validateAppSpec: () => ({ ok: false, errors: ['bad spec'] }),
  });
  assert.deepStrictEqual(validationFailed.emitResults[0].payload, { ok: false, error: 'downloaded App Spec failed validation', errors: ['bad spec'] });

  const defaulted = await runCase({
    runDownloadImpl: async () => ({
      ...lossyResult,
      spec: { ...minimalSpec(), directEntryDefaulted: ['overview'] },
      pages: [{ pageId: 'p1' }],
      entities: [{ schemaName: 'new_ticket' }],
      webResources: [{ name: 'new_icon' }],
      droppedSubareas: 0,
      dashboardReconstructionError: undefined,
      dashboardWarnings: [],
      notRoundTripped: { views: ['Active Tickets'] },
      solutionCandidates: { recovered: true },
    }),
    validateAppSpec: () => ({ ok: true, warnings: ['review warning'] }),
  });
  assert.match(defaulted.text, /WARNING: review warning/);
  assert.match(defaulted.text, /defaulted to/);
  assert.strictEqual(defaulted.emitResults[0].payload.pages, 1);
  assert.deepStrictEqual(defaulted.emitResults[0].payload.directEntryDefaulted, ['overview']);
  assert.deepStrictEqual(defaulted.emitResults[0].payload.notRoundTripped, { views: ['Active Tickets'] });
  assert.deepStrictEqual(defaulted.emitResults[0].payload.solutionCandidates, { recovered: true });
});

// The result names the page ids a download left in the page source only when it left some, like every other optional field of the result: an empty list is no
// finding, so it adds no field. `runDownload` leaves the field out when there is nothing to report, but another producer, or a test double, may hand back an
// empty list as easily as none — and a check on whether the list is THERE reports an empty one as a finding.
test('the download result carries navIdsLeft only when ids are left: none, or an empty list, adds no field', async () => {
  const left = [{ page: 'Overview', key: 'detail', id: APP_ID, line: 3, column: 5, why: 'quote' }];
  for (const [what, extra, expected] of [
    ['no list', {}, null],
    ['an empty list', { navIdsLeft: [] }, null],
    ['one id', { navIdsLeft: left }, left],
  ]) {
    const emitResults = [];
    await main(fakeMainDeps({
      outDir: tmp('download-navids-left-'),
      emitResults,
      runDownloadImpl: async () => ({ ok: true, spec: minimalSpec(), pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], dashboardWarnings: [], ...extra }),
    }));
    assert.strictEqual(emitResults.length, 1, what);
    assert.strictEqual(emitResults[0].ok, true, what);
    assert.strictEqual('navIdsLeft' in emitResults[0].payload, expected !== null, `${what}: the field is there only when ids are left`);
    if (expected) assert.deepStrictEqual(emitResults[0].payload.navIdsLeft, expected, what);
  }
});

test('baseline write remains best-effort when the folder workspace path cannot be a directory', async () => {
  const outDir = tmp('download-baseline-fails-');
  fs.writeFileSync(path.join(outDir, '.maker-workspace'), 'not a directory');
  const emitResults = [];
  await main(fakeMainDeps({ outDir, emitResults }));
  assert.strictEqual(emitResults[0].ok, true);
  assert.strictEqual(fs.readFileSync(path.join(outDir, '.maker-workspace'), 'utf8'), 'not a directory');
});

test('removes the temp workspace when SDK construction or initWorkspace throws', async () => {
  for (const [what, createMakerSdk] of [
    ['constructor throws', () => { throw new Error('constructor failed'); }],
    ['initWorkspace throws', () => ({ initWorkspace: async () => { throw new Error('init failed'); } })],
  ]) {
    let tempWorkspace;
    await assert.rejects(
      makeDownloadSdk(ENV, {
        mkdtempSync: () => {
          tempWorkspace = tmp('model-app-download-');
          return tempWorkspace;
        },
        createHttpClient: () => ({}),
        createNodeWorkspaceStorage: (workspaceDir) => ({ workspaceDir }),
        createMakerSdk,
      }),
      /failed/,
      what
    );
    assert.ok(tempWorkspace, `${what}: precondition`);
    assert.ok(!fs.existsSync(tempWorkspace), `${what}: temp workspace must not be stranded`);
  }
});

test('writes the deployed baseline to the folder workspace with the same content as the previous path', async () => {
  const outDir = tmp('download-baseline-');
  const emitResults = [];
  const spec = minimalSpec();
  await main(fakeMainDeps({
    outDir,
    emitResults,
    runDownloadImpl: async () => ({
      ok: true,
      spec,
      pages: [],
      entities: [],
      webResources: [],
      droppedSubareas: 0,
      droppedSubareaDetails: [],
      dashboardWarnings: [],
    }),
  }));

  const actual = fs.readFileSync(path.join(outDir, '.maker-workspace', 'last-applied.json'), 'utf8');
  const controlWorkspace = tmp('download-baseline-control-');
  writeBaseline(controlWorkspace, spec, {
    appDir: outDir,
    environment: ENV,
    appUniqueName: APP_UNIQUE,
    fromSpec: true,
  });
  const expected = fs.readFileSync(path.join(controlWorkspace, 'last-applied.json'), 'utf8');
  assert.strictEqual(actual, expected);
  assert.deepStrictEqual(emitResults.map((r) => r.ok), [true]);
});

test('leaves the folder workspace untouched except for last-applied.json when it already exists', async () => {
  const outDir = tmp('download-existing-workspace-');
  const workspace = path.join(outDir, '.maker-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'keep.txt'), 'keep');
  const before = listRelativeFiles(workspace);

  await main(fakeMainDeps({ outDir, emitResults: [] }));

  assert.deepStrictEqual(listRelativeFiles(workspace), [...before, 'last-applied.json'].sort());
  assert.ok(!fs.existsSync(path.join(workspace, 'manifest.json')), 'download must not create an SDK manifest in the folder workspace');
  assert.ok(!fs.existsSync(path.join(workspace, '.metadata')), 'download must not create SDK metadata in the folder workspace');
});

test('creates only last-applied.json in the folder workspace when no folder workspace existed', async () => {
  const outDir = tmp('download-no-workspace-');
  await main(fakeMainDeps({ outDir, emitResults: [] }));
  assert.deepStrictEqual(listRelativeFiles(path.join(outDir, '.maker-workspace')), ['last-applied.json']);
});

test('main wires the real download SDK factory to a throwaway workspace and still writes only the baseline to the folder workspace', async () => {
  const outDir = tmp('download-main-real-factory-');
  const emitResults = [];
  const constructed = [];
  await main({
    argv: ['--env', ENV, '--app', APP_UNIQUE, '--out', outDir],
    stderr: { write: () => {} },
    emitResult: (ok, payload) => emitResults.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    createHttpClient: () => ({}),
    createNodeWorkspaceStorage: (workspaceDir) => {
      constructed.push(workspaceDir);
      return { workspaceDir };
    },
    createMakerSdk: ({ workspaceStorage }) => ({
      initWorkspace: async () => {
        fs.mkdirSync(workspaceStorage.workspaceDir, { recursive: true });
        fs.writeFileSync(path.join(workspaceStorage.workspaceDir, 'manifest.json'), '{}');
      },
      queryRecords: async (logical, opts = {}) => {
        assert.strictEqual(logical, 'appmodule');
        const filter = opts.filter || '';
        if (/uniquename eq/.test(filter)) return [{ appmoduleid: APP_ID }];
        if (/appmoduleid eq/.test(filter)) return [{ uniquename: APP_UNIQUE }];
        return [];
      },
    }),
    makeGenpageCli: () => ({}),
    runDownload: async () => ({
      ok: true,
      spec: minimalSpec(),
      pages: [],
      entities: [],
      webResources: [],
      droppedSubareas: 0,
      droppedSubareaDetails: [],
      dashboardWarnings: [],
    }),
    validateAppSpec: () => ({ ok: true, warnings: [] }),
  });

  assert.strictEqual(emitResults[0].ok, true);
  assert.strictEqual(constructed.length, 1);
  assert.notStrictEqual(constructed[0], path.join(outDir, '.maker-workspace'));
  assert.ok(!constructed[0].startsWith(outDir), `download factory used output folder: ${constructed[0]}`);
  assert.ok(!fs.existsSync(constructed[0]), 'main cleans the real factory temp workspace');
  assert.deepStrictEqual(listRelativeFiles(path.join(outDir, '.maker-workspace')), ['last-applied.json']);
});

function realBundleHttp(state) {
  const appRow = () => ({
    appmoduleid: APP_ID,
    appmoduleidunique: APP_UNIQUE_ID,
    name: 'Workspace Probe',
    uniquename: APP_UNIQUE,
    description: state.description,
    componentstate: 0,
    '@odata.etag': state.etag,
  });
  const sitemapRow = () => ({
    sitemapid: SITEMAP_ID,
    sitemapnameunique: APP_UNIQUE,
    sitemapxml: '<SiteMap><Area><Group><SubArea Entity="new_ticket" /></Group></Area></SiteMap>',
    '@odata.etag': state.etag,
  });
  return {
    get: async (url) => {
      const meta = /EntityDefinitions\(LogicalName='([^']+)'\)/.exec(url);
      if (meta) return { status: 200, headers: {}, body: { LogicalName: meta[1], MetadataId: TABLE_METADATA_ID, EntitySetName: `${meta[1]}s` } };
      if (/\/appmodulecomponents/.test(url)) {
        const wantsSitemap = /componenttype(%20| )eq(%20| )62/.test(url);
        return { status: 200, headers: {}, body: { value: wantsSitemap ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [{ objectid: TABLE_METADATA_ID, componenttype: 1 }] } };
      }
      if (/\/sitemaps/.test(url)) {
        const multi = /RetrieveUnpublishedMultiple/i.test(url) || /\/sitemaps\?/.test(url);
        return { status: 200, headers: { etag: state.etag }, body: multi ? { value: [sitemapRow()] } : sitemapRow() };
      }
      if (/\/appmodules/.test(url)) {
        const multi = /RetrieveUnpublishedMultiple/i.test(url) || /\/appmodules\?/.test(url);
        return { status: 200, headers: { etag: state.etag }, body: multi ? { value: [appRow()] } : appRow() };
      }
      return { status: 200, headers: {}, body: { value: [] } };
    },
    post: async () => ({ status: 204, headers: {}, body: {} }),
    patch: async () => ({ status: 204, headers: { etag: state.etag }, body: {} }),
    delete: async () => ({ status: 204, headers: {}, body: {} }),
    put: async () => ({ status: 204, headers: {}, body: {} }),
  };
}

async function realSdk(workspaceDir, state) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const sdk = createMakerSdk({
    workspaceStorage: createNodeWorkspaceStorage(workspaceDir),
    instanceUrl: ENV,
    httpClient: realBundleHttp(state),
  });
  await sdk.initWorkspace();
  return sdk;
}

test('REAL BUNDLE: moved server makes the old folder workspace throw, while the isolated download reads deployed content', async () => {
  const outDir = tmp('download-real-moved-');
  const workspace = path.join(outDir, '.maker-workspace');
  const state = { etag: 'W/"1"', description: 'Server description v1' };
  const oldSdk = await realSdk(workspace, state);
  await oldSdk.fetchArtifact('app', APP_ID);
  await oldSdk.updateElement('app', APP_ID, '/description', 'Local unpushed edit');
  Object.assign(state, { etag: 'W/"2"', description: 'Server description v2' });

  await assert.rejects(oldSdk.fetchArtifact('app', APP_ID), (err) => err && err.code === 'LOCAL_EDITS_WOULD_BE_LOST');

  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const isolated = await makeDownloadSdk(ENV, {
    createMakerSdk,
    createNodeWorkspaceStorage,
    createHttpClient: () => realBundleHttp(state),
  });
  try {
    const deployed = await isolated.sdk.fetchArtifact('app', APP_ID);
    assert.strictEqual(deployed.description, 'Server description v2');
    assert.ok(!isolated.workspaceDir.startsWith(outDir), 'download workspace must be outside the output folder');
  } finally {
    isolated.cleanup();
  }
  assert.ok(!fs.existsSync(isolated.workspaceDir), 'real-bundle isolated workspace is removed');
});

test('REAL BUNDLE: unchanged server makes the old folder workspace return local edits, while the isolated download reads deployed content', async () => {
  const outDir = tmp('download-real-clean-');
  const workspace = path.join(outDir, '.maker-workspace');
  const state = { etag: 'W/"1"', description: 'Server description' };
  const oldSdk = await realSdk(workspace, state);
  await oldSdk.fetchArtifact('app', APP_ID);
  await oldSdk.updateElement('app', APP_ID, '/description', 'Local unpushed edit');

  const oldPath = await oldSdk.fetchArtifact('app', APP_ID);
  assert.strictEqual(oldPath.description, 'Local unpushed edit', 'old download path would silently read the unpushed local copy');

  const { createMakerSdk, createNodeWorkspaceStorage } = require(BUNDLE);
  const isolated = await makeDownloadSdk(ENV, {
    createMakerSdk,
    createNodeWorkspaceStorage,
    createHttpClient: () => realBundleHttp(state),
  });
  try {
    const deployed = await isolated.sdk.fetchArtifact('app', APP_ID);
    assert.strictEqual(deployed.description, 'Server description');
  } finally {
    isolated.cleanup();
  }
  assert.ok(!fs.existsSync(isolated.workspaceDir), 'real-bundle isolated workspace is removed');
});

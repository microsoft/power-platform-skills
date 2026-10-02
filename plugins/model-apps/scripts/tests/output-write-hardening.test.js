'use strict';
// Output writes into a folder the user named must not follow a link left at that name.
// A symbolic link, a directory junction, or a hard link would make the write land on some
// other file. These tests pin each sink: refuse, leave the other name unchanged, and keep
// writing a normal folder exactly as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { openJournal } = require('../lib/build-journal.js');
const { assertPlainFileTarget } = require('../lib/safe-fs.js');
const { main: downloadMain, runDownload } = require('../download-model-app.js');
const { readerFor } = require('../verify-model-app.js');
const { buildModelApp } = require('../build-model-app.js');
const { loadCli } = require('./helpers/cli-harness.js');

const KEEP = 'KEEP-OUTSIDE\n';
const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'outwrite-'));
  dirs.push(d);
  return name ? path.join(d, name) : d;
}

// Creating a symlink can need an extra privilege. A junction does not, on Windows.
// Skip only the link type this host refused, and say why.
function tryLink(t, target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (e) {
    if (e && e.code === 'EPERM') {
      t.skip(`${type} symlink needs an extra privilege on this host (EPERM)`);
      return false;
    }
    throw e;
  }
}

function tryHardLink(t, target, link) {
  try {
    fs.linkSync(target, link);
    return true;
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'ENOTSUP' || e.code === 'EOPNOTSUPP' || e.code === 'EINVAL' || e.code === 'EXDEV')) {
      t.skip(`hard link not available here (${e.code})`);
      return false;
    }
    throw e;
  }
}

function outsideFile(base, name) {
  const file = path.join(base, name);
  fs.writeFileSync(file, KEEP);
  return file;
}

// --- build journal -----------------------------------------------------------------

test('openJournal still writes the log and the status file in a normal directory', () => {
  const dir = tmp('journal-ok');
  fs.mkdirSync(dir);
  const j = openJournal(dir, { app: 'X' });
  j.record({ phase: 'forms', status: 'ok', label: 'form' });
  j.close({ status: 'complete', ok: 1 });
  const log = fs.readFileSync(path.join(dir, 'build-log.jsonl'), 'utf8');
  assert.match(log, /run-start/);
  assert.match(log, /run-end/);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'build-status.json'), 'utf8'));
  assert.equal(status.state, 'done');
  assert.equal(status.app, 'X');
});

test('openJournal refuses a junction at the journal directory and does not write into it', () => {
  const base = tmp();
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const link = path.join(base, 'journal');
  fs.symlinkSync(real, link, 'junction');
  assert.throws(() => openJournal(link), /symbolic link or junction/);
  assert.equal(fs.readFileSync(path.join(real, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(real, 'build-log.jsonl')), false);
  assert.equal(fs.existsSync(path.join(real, 'build-status.json')), false);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the junction is left in place');
});

test('openJournal refuses a directory symlink at the journal directory', (t) => {
  const base = tmp();
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const link = path.join(base, 'journal-sym');
  if (!tryLink(t, real, link, 'dir')) return;
  assert.throws(() => openJournal(link), /symbolic link or junction/);
  assert.equal(fs.readFileSync(path.join(real, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(real, 'build-log.jsonl')), false);
});

test('openJournal refuses a hard link at build-log.jsonl and leaves the other name unchanged', (t) => {
  const dir = tmp('journal-hl');
  fs.mkdirSync(dir);
  const outside = outsideFile(dir, 'outside.jsonl');
  const log = path.join(dir, 'build-log.jsonl');
  if (!tryHardLink(t, outside, log)) return;
  assert.throws(() => openJournal(dir), /hard link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
  assert.equal(fs.statSync(outside).nlink, 2, 'the extra name is still the same file');
});

test('openJournal refuses a symlink at build-log.jsonl and leaves the other name unchanged', (t) => {
  const dir = tmp('journal-symfile');
  fs.mkdirSync(dir);
  const outside = outsideFile(dir, 'outside-log.jsonl');
  const log = path.join(dir, 'build-log.jsonl');
  if (!tryLink(t, outside, log, 'file')) return;
  assert.throws(() => openJournal(dir), /symbolic link or junction/);
  assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
  assert.equal(fs.lstatSync(log).isSymbolicLink(), true);
});

test('a link at build-status.json does not fail the journal, warns once, and leaves the other name', (t) => {
  const dir = tmp('journal-status');
  fs.mkdirSync(dir);
  const outside = outsideFile(dir, 'outside-status.json');
  const status = path.join(dir, 'build-status.json');
  if (!tryHardLink(t, outside, status)) return;
  const warnings = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, enc, cb) => {
    warnings.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    const j = openJournal(dir, { app: 'X' });
    j.record({ phase: 'forms', status: 'ok', label: 'a' });
    j.record({ phase: 'views', status: 'ok', label: 'b' });
    j.close({ status: 'complete' });
    assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
    assert.equal(fs.statSync(outside).nlink, 2);
    assert.match(fs.readFileSync(j.path, 'utf8'), /run-end/, 'the log is still recorded');
    const hits = warnings.filter((w) => /refusing to write/.test(w) && /build-status\.json/.test(w));
    assert.equal(hits.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
  } finally {
    process.stderr.write = orig;
  }
});

test('a symlink at build-status.json warns once and is not followed', (t) => {
  const dir = tmp('journal-status-sym');
  fs.mkdirSync(dir);
  const outside = outsideFile(dir, 'outside-status-sym.json');
  const status = path.join(dir, 'build-status.json');
  if (!tryLink(t, outside, status, 'file')) return;
  const warnings = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, enc, cb) => {
    warnings.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    const j = openJournal(dir);
    j.close({ status: 'complete' });
    assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
    assert.equal(fs.lstatSync(status).isSymbolicLink(), true);
    assert.equal(warnings.filter((w) => /refusing to write/.test(w)).length, 1);
  } finally {
    process.stderr.write = orig;
  }
});

test('a junction at the build-status.json name warns once and is not followed', () => {
  const dir = tmp('journal-status-junc');
  fs.mkdirSync(dir);
  const outside = path.join(dir, 'outside-dir');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker'), KEEP);
  const status = path.join(dir, 'build-status.json');
  fs.symlinkSync(outside, status, 'junction');
  const warnings = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, enc, cb) => {
    warnings.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    openJournal(dir).close({ status: 'done' });
    assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), KEEP);
    assert.equal(fs.existsSync(path.join(outside, 'build-status.json')), false);
    assert.equal(warnings.filter((w) => /refusing to write|junction|not a regular file/.test(w)).length, 1);
  } finally {
    process.stderr.write = orig;
  }
});

// --- app spec doc ------------------------------------------------------------------

const DOC_CLI = path.join(__dirname, '..', 'write-app-spec-doc.js');
const DOC_SPEC = {
  solution: { uniqueName: 'ContosoSupport', publisherPrefix: 'new' },
  app: { name: 'Support Desk', uniqueName: 'contoso_support' },
};

function runDocCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [DOC_CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

function specFile() {
  const dir = tmp('specdir');
  fs.mkdirSync(dir);
  const spec = path.join(dir, 'app-spec.json');
  fs.writeFileSync(spec, JSON.stringify(DOC_SPEC));
  return spec;
}

test('write-app-spec-doc still writes the plan into a normal directory', () => {
  const spec = specFile();
  const out = path.join(path.dirname(spec), 'model-app-plan.md');
  const r = runDocCli(['--spec', '@' + spec, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /Support Desk/);
});

test('write-app-spec-doc refuses a junction as the document directory', () => {
  const spec = specFile();
  const base = tmp();
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const link = path.join(base, 'docs');
  fs.symlinkSync(real, link, 'junction');
  const out = path.join(link, 'model-app-plan.md');
  const r = runDocCli(['--spec', '@' + spec, '--out', out]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /symbolic link or junction/);
  assert.match(r.stderr + r.stdout, /docs/);
  assert.equal(fs.readFileSync(path.join(real, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(real, 'model-app-plan.md')), false);
});

test('write-app-spec-doc refuses a directory symlink as the document directory', (t) => {
  const spec = specFile();
  const base = tmp();
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const link = path.join(base, 'docs-sym');
  if (!tryLink(t, real, link, 'dir')) return;
  const r = runDocCli(['--spec', '@' + spec, '--out', path.join(link, 'plan.md')]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /symbolic link or junction/);
  assert.equal(fs.existsSync(path.join(real, 'plan.md')), false);
});

test('write-app-spec-doc refuses a symlink, a junction, and a hard link at the document name', (t) => {
  const spec = specFile();
  const dir = tmp('doc-targets');
  fs.mkdirSync(dir);
  const outside = outsideFile(dir, 'outside.md');

  const sym = path.join(dir, 'sym.md');
  if (tryLink(t, outside, sym, 'file')) {
    const r = runDocCli(['--spec', '@' + spec, '--out', sym]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /symbolic link or junction/);
    assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
    assert.equal(fs.lstatSync(sym).isSymbolicLink(), true);
  }

  const junc = path.join(dir, 'junc.md');
  const jTarget = path.join(dir, 'junc-target');
  fs.mkdirSync(jTarget);
  fs.writeFileSync(path.join(jTarget, 'marker'), KEEP);
  fs.symlinkSync(jTarget, junc, 'junction');
  const jr = runDocCli(['--spec', '@' + spec, '--out', junc]);
  assert.notEqual(jr.code, 0);
  assert.match(jr.stderr + jr.stdout, /junction|not a regular file|symbolic link/);
  assert.equal(fs.readFileSync(path.join(jTarget, 'marker'), 'utf8'), KEEP);

  const hard = path.join(dir, 'hard.md');
  const hardOutside = outsideFile(dir, 'hard-outside.md');
  if (tryHardLink(t, hardOutside, hard)) {
    const r = runDocCli(['--spec', '@' + spec, '--out', hard]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr + r.stdout, /hard link/);
    assert.equal(fs.readFileSync(hardOutside, 'utf8'), KEEP);
    assert.equal(fs.statSync(hardOutside).nlink, 2);
  }
});

// --- download ----------------------------------------------------------------------

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function captureDownload(argv, extra = {}) {
  const calls = { auth: 0, sdk: 0, download: 0 };
  const emitted = [];
  const stderr = [];
  const deps = {
    argv,
    stderr: { write: (s) => { stderr.push(String(s)); return true; } },
    exit: (code) => {
      const err = new Error(`process.exit(${code})`);
      err.exitCode = code;
      throw err;
    },
    emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
    preflightAuth: async () => { calls.auth += 1; return { ok: true }; },
    makeDownloadSdk: async () => {
      calls.sdk += 1;
      return { sdk: { queryRecords: async () => [] }, cleanup() {} };
    },
    runDownload: extra.runDownload || (async () => { calls.download += 1; return { ok: false, error: 'not used' }; }),
    validateAppSpec: extra.validateAppSpec || (() => ({ ok: true, warnings: [] })),
  };
  return downloadMain(deps).then(
    () => ({ calls, emitted, stderr: stderr.join(''), threw: null }),
    (err) => ({ calls, emitted, stderr: stderr.join(''), threw: err }),
  );
}

test('download refuses a junction --out before any auth or SDK call', async () => {
  const base = tmp();
  const real = path.join(base, 'real-out');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const out = path.join(base, 'out-junc');
  fs.symlinkSync(real, out, 'junction');
  const r = await captureDownload(['--env', ENV, '--app', APP, '--out', out]);
  assert.equal(r.calls.auth, 0, 'auth must not run');
  assert.equal(r.calls.sdk, 0, 'SDK must not be constructed');
  assert.equal(r.calls.download, 0);
  const text = r.stderr + JSON.stringify(r.emitted) + (r.threw ? r.threw.message : '');
  assert.match(text, /symbolic link or junction/);
  assert.match(text, /out-junc/);
  assert.equal(fs.readFileSync(path.join(real, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(real, 'app-spec.json')), false);
  assert.equal(fs.lstatSync(out).isSymbolicLink(), true);
});

test('download refuses a directory symlink --out before any auth or SDK call', async (t) => {
  const base = tmp();
  const real = path.join(base, 'real-out');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const out = path.join(base, 'out-sym');
  if (!tryLink(t, real, out, 'dir')) return;
  const r = await captureDownload(['--env', ENV, '--app', APP, '--out', out]);
  assert.equal(r.calls.auth, 0);
  assert.equal(r.calls.sdk, 0);
  const text = r.stderr + JSON.stringify(r.emitted) + (r.threw ? r.threw.message : '');
  assert.match(text, /symbolic link or junction/);
  assert.equal(fs.existsSync(path.join(real, 'app-spec.json')), false);
});

test('download still writes app-spec.json into a normal --out directory', async () => {
  const out = tmp('dl-ok');
  fs.mkdirSync(out);
  const spec = { app: { name: 'Downloaded', uniqueName: 'contoso_downloaded' }, solution: { uniqueName: 'S', publisherPrefix: 'new' } };
  const r = await captureDownload(['--env', ENV, '--app', APP, '--out', out], {
    runDownload: async () => ({
      ok: true,
      spec,
      pages: [],
      entities: [],
      webResources: [],
      droppedSubareas: 0,
    }),
  });
  assert.equal(r.threw, null, r.threw && r.threw.stack);
  assert.equal(r.emitted[0] && r.emitted[0].ok, true, JSON.stringify(r.emitted));
  const written = JSON.parse(fs.readFileSync(path.join(out, 'app-spec.json'), 'utf8'));
  assert.equal(written.app.name, 'Downloaded');
});

test('download refuses a symlink, a junction, and a hard link at app-spec.json', async (t) => {
  const out = tmp('dl-spec');
  fs.mkdirSync(out);
  const spec = { app: { name: 'Downloaded' } };
  const run = {
    runDownload: async () => ({ ok: true, spec, pages: [], entities: [], webResources: [], droppedSubareas: 0 }),
  };

  const outside = outsideFile(out, 'outside-spec.json');
  const sym = path.join(out, 'app-spec.json');
  if (tryLink(t, outside, sym, 'file')) {
    const r = await captureDownload(['--env', ENV, '--app', APP, '--out', out], run);
    const text = r.stderr + JSON.stringify(r.emitted) + (r.threw ? r.threw.message : '');
    assert.match(text, /symbolic link or junction/);
    assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
    assert.equal(fs.lstatSync(sym).isSymbolicLink(), true);
    fs.unlinkSync(sym);
  }

  const jTarget = path.join(out, 'spec-junc-target');
  fs.mkdirSync(jTarget);
  fs.writeFileSync(path.join(jTarget, 'marker'), KEEP);
  const junc = path.join(out, 'app-spec.json');
  fs.symlinkSync(jTarget, junc, 'junction');
  const jr = await captureDownload(['--env', ENV, '--app', APP, '--out', out], run);
  const jtext = jr.stderr + JSON.stringify(jr.emitted) + (jr.threw ? jr.threw.message : '');
  assert.match(jtext, /junction|not a regular file|symbolic link/);
  assert.equal(fs.readFileSync(path.join(jTarget, 'marker'), 'utf8'), KEEP);
  fs.rmSync(junc, { recursive: true, force: true });

  const hardOutside = outsideFile(out, 'hard-spec.json');
  const hard = path.join(out, 'app-spec.json');
  if (tryHardLink(t, hardOutside, hard)) {
    const r = await captureDownload(['--env', ENV, '--app', APP, '--out', out], run);
    const text = r.stderr + JSON.stringify(r.emitted) + (r.threw ? r.threw.message : '');
    assert.match(text, /hard link/);
    assert.equal(fs.readFileSync(hardOutside, 'utf8'), KEEP);
    assert.equal(fs.statSync(hardOutside).nlink, 2);
  }
});

const PAGE = 'aaaaaaaa-0000-4000-8000-000000000001';
const APP_ID = 'cccccccc-0000-4000-8000-000000000003';
const APP_UNIQUE = 'contoso_pages';

function navSource(id) {
  return `export default function P(){ Xrm.Navigation.navigateTo({pageType:"generative",pageId:"${id}"}); return null; }\n`;
}

function pageSdk(fetchCalls) {
  const xml = `<SiteMap><Area><Group><SubArea GenPageId="${PAGE}" Title="Overview"/></Group></Area></SiteMap>`;
  return {
    fetchArtifact: async () => {
      if (fetchCalls) fetchCalls.n += 1;
      return {
        name: 'Pages App',
        description: '',
        siteMap: { areas: [{ title: 'Main', groups: [{ title: 'Pages', subAreas: [{ type: 'GenPage', genPageId: PAGE, title: 'Overview' }] }] }] },
      };
    },
    queryRecords: async (logical) => {
      if (logical === 'appmodule') return [{ appmoduleid: APP_ID, appmoduleidunique: 'cccccccc-0000-4000-8000-000000000004', uniquename: APP_UNIQUE }];
      if (logical === 'appmodulecomponent') return [{ objectid: 'cccccccc-0000-4000-8000-000000000005', componenttype: 62 }];
      if (logical === 'sitemap') return [{ sitemapxml: xml }];
      return [];
    },
    fetchEntityMetadata: async () => ({ schemaName: 'contoso_item', displayName: 'Item', primaryNameAttribute: 'contoso_name', attributes: [], relationships: [] }),
    dataverse: { get: async () => ({ status: 200, body: { value: [] } }) },
  };
}

test('download refuses a junction pages root before pac download and leaves the outside directory', async () => {
  const base = tmp();
  const out = path.join(base, 'out');
  const outside = path.join(base, 'outside-pages');
  fs.mkdirSync(out);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker'), KEEP);
  const pagesRoot = path.join(out, 'pages');
  fs.symlinkSync(outside, pagesRoot, 'junction');
  let downloads = 0;
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, pages: [{ pageId: PAGE, name: 'Overview' }] }),
    download: async () => { downloads += 1; return true; },
  };
  await assert.rejects(
    () => runDownload({ sdk: pageSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE }),
    /symbolic link or junction/,
  );
  assert.equal(downloads, 0, 'pac download must not run');
  assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.lstatSync(pagesRoot).isSymbolicLink(), true, 'the junction is left in place');
});

test('download refuses a symlink pages root before pac download', async (t) => {
  const base = tmp();
  const out = path.join(base, 'out');
  const outside = path.join(base, 'outside-pages');
  fs.mkdirSync(out);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker'), KEEP);
  const pagesRoot = path.join(out, 'pages');
  if (!tryLink(t, outside, pagesRoot, 'dir')) return;
  let downloads = 0;
  await assert.rejects(
    () => runDownload({
      sdk: pageSdk(),
      genpageCli: {
        enumerateEnv: async () => ({ ok: true, pages: [] }),
        download: async () => { downloads += 1; },
      },
      outDir: out,
      appId: APP_ID,
      appUnique: APP_UNIQUE,
    }),
    /symbolic link or junction/,
  );
  assert.equal(downloads, 0);
  assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), KEEP);
});

async function rewriteThrough(t, plant) {
  const base = tmp();
  const out = path.join(base, 'out');
  const destDir = path.join(out, 'pages', PAGE);
  fs.mkdirSync(destDir, { recursive: true });
  const outside = outsideFile(base, 'outside-page.tsx');
  fs.writeFileSync(outside, navSource(PAGE));
  // The link is at the destination name. pac writes a private copy; the install must not follow this.
  if (!plant(t, outside, path.join(destDir, 'page.tsx'))) return false;
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, pages: [{ pageId: PAGE, name: 'Overview' }] }),
    download: async ({ outputDir }) => {
      const dir = path.join(outputDir, PAGE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'page.tsx'), navSource(PAGE), 'utf8');
      fs.writeFileSync(path.join(dir, 'config.json'), '{"dataSources":[]}', 'utf8');
    },
  };
  await assert.rejects(
    () => runDownload({ sdk: pageSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE }),
    /refusing to write|symbolic link or junction|hard link/,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), navSource(PAGE));
  return true;
}

test('download refuses a symlink at the page file and leaves the outside file', async (t) => {
  await rewriteThrough(t, (tt, outside, pageFile) => tryLink(tt, outside, pageFile, 'file'));
});

test('download refuses a hard link at the page file and leaves the outside file', async (t) => {
  const base = tmp();
  const out = path.join(base, 'out');
  const destDir = path.join(out, 'pages', PAGE);
  fs.mkdirSync(destDir, { recursive: true });
  const outside = path.join(base, 'outside-hard.tsx');
  fs.writeFileSync(outside, navSource(PAGE));
  if (!tryHardLink(t, outside, path.join(destDir, 'page.tsx'))) return;
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, pages: [{ pageId: PAGE, name: 'Overview' }] }),
    download: async ({ outputDir }) => {
      const dir = path.join(outputDir, PAGE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'page.tsx'), navSource(PAGE), 'utf8');
      fs.writeFileSync(path.join(dir, 'config.json'), '{"dataSources":[]}', 'utf8');
    },
  };
  await assert.rejects(
    () => runDownload({ sdk: pageSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE }),
    /hard link/,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), navSource(PAGE));
  assert.equal(fs.statSync(outside).nlink, 2);
});

test('download refuses a junction at the page file name and leaves the outside directory', async () => {
  const base = tmp();
  const out = path.join(base, 'out');
  const outside = path.join(base, 'outside-page-dir');
  const destDir = path.join(out, 'pages', PAGE);
  fs.mkdirSync(destDir, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker'), KEEP);
  fs.symlinkSync(outside, path.join(destDir, 'page.tsx'), 'junction');
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, pages: [{ pageId: PAGE, name: 'Overview' }] }),
    download: async ({ outputDir }) => {
      const dir = path.join(outputDir, PAGE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'page.tsx'), navSource(PAGE), 'utf8');
      fs.writeFileSync(path.join(dir, 'config.json'), '{"dataSources":[]}', 'utf8');
    },
  };
  await assert.rejects(
    () => runDownload({ sdk: pageSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE }),
    /refusing to write|junction|not a regular file|symbolic link/,
  );
  assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(outside, 'page.tsx')), false);
});

test('download still rewrites a page file in a normal folder', async () => {
  const out = tmp('dl-page-ok');
  fs.mkdirSync(out);
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, pages: [{ pageId: PAGE, name: 'Overview' }] }),
    download: async ({ outputDir }) => {
      const dir = path.join(outputDir, PAGE);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'page.tsx'), navSource(PAGE), 'utf8');
      fs.writeFileSync(path.join(dir, 'config.json'), '{"dataSources":[]}', 'utf8');
      return true;
    },
  };
  const res = await runDownload({ sdk: pageSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
  assert.equal(res.ok, true, JSON.stringify(res));
  const written = fs.readFileSync(path.join(out, 'pages', PAGE, 'page.tsx'), 'utf8');
  assert.match(written, /PAGEREF_/);
  assert.doesNotMatch(written, new RegExp(PAGE));
});

test('download refuses a junction at .maker-workspace before writing the baseline', async () => {
  const base = tmp();
  const out = path.join(base, 'out');
  const outside = path.join(base, 'outside-ws');
  fs.mkdirSync(out);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker'), KEEP);
  fs.symlinkSync(outside, path.join(out, '.maker-workspace'), 'junction');
  const stderr = [];
  await downloadMain({
    argv: ['--env', ENV, '--app', APP, '--out', out],
    stderr: { write: (s) => { stderr.push(String(s)); return true; } },
    exit: () => {},
    emitResult: () => {},
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: { queryRecords: async () => [] }, cleanup() {} }),
    runDownload: async () => ({
      ok: true,
      spec: { app: { name: 'Downloaded', uniqueName: 'contoso_downloaded' } },
      pages: [],
      entities: [],
      webResources: [],
      droppedSubareas: 0,
    }),
    validateAppSpec: () => ({ ok: true, warnings: [] }),
  });
  assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(outside, 'last-applied.json')), false);
  assert.match(stderr.join(''), /symbolic link or junction|\.maker-workspace/);
  assert.match(fs.readFileSync(path.join(out, 'app-spec.json'), 'utf8'), /Downloaded/);
});

// --- build workspace and approval record -------------------------------------------

const BUILD_CLI = path.join(__dirname, '..', 'build-model-app.js');
const realAuth = require('../lib/dataverse-auth.js');

// emitResult lives in a required module, so it sees the real process.exit. A stub that throws
// keeps the test runner alive and still proves the CLI halted.
function loadBuild(argv, factory) {
  return loadCli(BUILD_CLI, {
    argv,
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': {
        ...realAuth,
        emitResult: (ok, payload) => {
          const message = payload instanceof Error
            ? payload.message
            : (payload && (payload.error || payload.message)) || String(payload);
          const err = new Error(message);
          err.exitCode = ok ? 0 : 1;
          err.payload = payload;
          throw err;
        },
      },
      './vendor/cds-maker-sdk.cjs': {
        createMakerSdk: (...args) => factory(args[0]),
        createNodeWorkspaceStorage: (dir) => ({ dir }),
      },
    },
  });
}

function buildSpec(dir) {
  const specPath = path.join(dir, 'app-spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    solution: { uniqueName: 'ContosoSupport', publisherPrefix: 'new' },
    app: { name: 'Support Desk', uniqueName: 'contoso_support' },
  }));
  return specPath;
}

test('build refuses a junction workspace before the SDK factory is called', async () => {
  const base = tmp();
  const specPath = buildSpec(base);
  const real = path.join(base, 'real-ws');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const ws = path.join(base, 'ws-junc');
  fs.symlinkSync(real, ws, 'junction');
  let factoryCalls = 0;
  const cli = loadBuild(
    ['--env', ENV, '--spec', '@' + specPath, '--workspace', ws, '--no-live-plan'],
    () => { factoryCalls += 1; return { initWorkspace: async () => {} }; },
  );
  let halted = null;
  try { await cli.main(); } catch (e) { halted = e; }
  assert.equal(halted && halted.exitCode, 1);
  assert.equal(factoryCalls, 0, 'SDK factory must not be called');
  const text = (halted && halted.message) + cli.stderrText() + cli.stdoutText();
  assert.match(text, /symbolic link or junction/);
  assert.match(text, /ws-junc/);
  assert.equal(fs.readFileSync(path.join(real, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(real, 'destructive-approval.json')), false);
});

test('build refuses a directory symlink workspace before the SDK factory is called', async (t) => {
  const base = tmp();
  const specPath = buildSpec(base);
  const real = path.join(base, 'real-ws');
  fs.mkdirSync(real);
  const ws = path.join(base, 'ws-sym');
  if (!tryLink(t, real, ws, 'dir')) return;
  let factoryCalls = 0;
  const cli = loadBuild(
    ['--env', ENV, '--spec', '@' + specPath, '--workspace', ws, '--no-live-plan'],
    () => { factoryCalls += 1; return { initWorkspace: async () => {} }; },
  );
  let halted = null;
  try { await cli.main(); } catch (e) { halted = e; }
  assert.equal(halted && halted.exitCode, 1);
  assert.equal(factoryCalls, 0);
  assert.match((halted && halted.message) + cli.stderrText() + cli.stdoutText(), /symbolic link or junction/);
});

test('build still constructs the SDK for an explicit real --workspace directory', async () => {
  const base = tmp();
  const specPath = buildSpec(base);
  const ws = path.join(base, 'ws-real');
  fs.mkdirSync(ws);
  let factoryCalls = 0;
  const cli = loadBuild(
    ['--env', ENV, '--spec', '@' + specPath, '--workspace', ws, '--no-live-plan'],
    () => { factoryCalls += 1; return { initWorkspace: async () => {} }; },
  );
  await assert.rejects(() => cli.main(), (e) => e && (e.exitCode === 1 || e.exitCode === 0));
  assert.ok(factoryCalls >= 1, 'a real workspace is still constructed');
  assert.equal(fs.lstatSync(ws).isSymbolicLink(), false);
  assert.equal(fs.statSync(ws).isDirectory(), true);
});

test('verify refuses a junction workspace before the SDK factory is called', async () => {
  const base = tmp();
  const specPath = path.join(base, 'app-spec.json');
  fs.copyFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), specPath);
  const real = path.join(base, 'real-ws');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'marker'), KEEP);
  const ws = path.join(base, 'verify-junc');
  fs.symlinkSync(real, ws, 'junction');
  let factoryCalls = 0;
  const cli = loadCli(path.join(__dirname, '..', 'verify-model-app.js'), {
    argv: ['--env', ENV, '--spec', '@' + specPath, '--workspace', ws],
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': {
        ...realAuth,
        emitResult: (ok, payload) => {
          const message = payload instanceof Error
            ? payload.message
            : (payload && (payload.error || payload.message)) || String(payload);
          const err = new Error(message);
          err.exitCode = ok ? 0 : 1;
          throw err;
        },
      },
      './vendor/cds-maker-sdk.cjs': {
        createMakerSdk: () => { factoryCalls += 1; return { initWorkspace: async () => {} }; },
        createNodeWorkspaceStorage: () => ({}),
      },
    },
  });
  let halted = null;
  try { await cli.main(); } catch (e) { halted = e; }
  assert.equal(halted && halted.exitCode, 1, halted && halted.message);
  assert.equal(factoryCalls, 0, 'SDK factory must not be called');
  assert.match((halted && halted.message) + cli.stderrText() + cli.stdoutText(), /symbolic link or junction/);
  assert.equal(fs.readFileSync(path.join(real, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.lstatSync(ws).isSymbolicLink(), true);
});

test('build refuses a symlink, a junction, and a hard link at destructive-approval.json', async (t) => {
  const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));
  const cell = (fn) => ({ control: { fieldName: fn } });
  const formOf = (fields) => ({ tabs: [{ columns: [{ sections: [{ rows: fields.map((f) => ({ cells: [cell(f)] })) }] }] }] });
  const state = {
    collision: { appExists: false, solutionExists: false },
    forms: [{
      formId: 'form-1',
      label: 'form "Ticket" (new_ticket)',
      deployedForm: formOf(['new_name', 'new_priority']),
      def: Object.assign(formOf(['new_name']), { __explicitLayout: true, __primaryField: 'new_name' }),
    }],
    sitemap: { deployedTargets: ['entity:new_customer', 'entity:new_ticket'], wantTargets: ['entity:new_customer'] },
  };
  async function refuse(workspaceDir) {
    const logs = [];
    const r = await buildModelApp(desk, { apply: true, env: ENV, retryDelayMs: 0, workspaceDir }, {
      sdk: {},
      provisionSdk: {},
      discoverOpDiffState: async () => state,
      runBuild: async () => { throw new Error('build must not run after a refused approval write'); },
      log: (m) => logs.push(String(m)),
      sleep: async () => {},
    });
    return { r, logs: logs.join('\n') };
  }

  const base = tmp();
  const ws = path.join(base, 'ws');
  fs.mkdirSync(ws);
  const outside = outsideFile(base, 'outside-approval.json');
  const file = path.join(ws, 'destructive-approval.json');
  if (tryLink(t, outside, file, 'file')) {
    const { logs } = await refuse(ws);
    assert.match(logs, /symbolic link or junction|refusing to write/);
    assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    fs.unlinkSync(file);
  }

  const jTarget = path.join(base, 'approval-junc');
  fs.mkdirSync(jTarget);
  fs.writeFileSync(path.join(jTarget, 'marker'), KEEP);
  fs.symlinkSync(jTarget, file, 'junction');
  const j = await refuse(ws);
  assert.match(j.logs, /junction|not a regular file|symbolic link|refusing to write/);
  assert.equal(fs.readFileSync(path.join(jTarget, 'marker'), 'utf8'), KEEP);
  fs.rmSync(file, { recursive: true, force: true });

  const hardOutside = outsideFile(base, 'hard-approval.json');
  if (tryHardLink(t, hardOutside, file)) {
    const { logs } = await refuse(ws);
    assert.match(logs, /hard link/);
    assert.equal(fs.readFileSync(hardOutside, 'utf8'), KEEP);
    assert.equal(fs.statSync(hardOutside).nlink, 2);
  }
});

test('a realpath failure on a plain journal directory disables journaling and warns once', () => {
  const dir = tmp('journal-eio');
  fs.mkdirSync(dir);
  const warnings = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, enc, cb) => {
    warnings.push(String(chunk));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  const eio = () => {
    const err = new Error('EIO');
    err.code = 'EIO';
    throw err;
  };
  const fake = {
    lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }),
    readlinkSync: () => { const err = new Error('EINVAL'); err.code = 'EINVAL'; throw err; },
    mkdirSync: () => {},
    realpathSync: Object.assign(eio, { native: eio }),
  };
  try {
    const j = openJournal(dir, { app: 'X' }, { fs: fake });
    assert.equal(j.path, null, 'journaling is disabled');
    assert.doesNotThrow(() => { j.record({ status: 'ok' }); j.close({ status: 'done' }); });
    assert.equal(warnings.filter((w) => /WARNING:/.test(w) && /could not be resolved/.test(w)).length, 1);
  } finally {
    process.stderr.write = orig;
  }
});

test('assertPlainFileTarget refuses a hard link without writing, even if the other name is gone on a later look', () => {
  let nlink = 2;
  const writes = [];
  const fake = {
    lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, nlink, mode: 0o666 }),
    readlinkSync: () => { const err = new Error('EINVAL'); err.code = 'EINVAL'; throw err; },
    openSync: () => { writes.push('open'); return 1; },
    writeFileSync: () => { writes.push('write'); },
    appendFileSync: () => { writes.push('append'); },
  };
  assert.throws(
    () => assertPlainFileTarget(path.join(os.tmpdir(), 'shared.txt'), { fs: fake }),
    (err) => err && err.reason === 'hard-link',
  );
  nlink = 1;
  assert.deepEqual(writes, [], 'a refusal must not open or write');
});

test('verify page download leaves a junction at verify-pages and its target untouched', async () => {
  const base = tmp();
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside-pages');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'marker'), KEEP);
  const planted = path.join(ws, 'verify-pages');
  fs.symlinkSync(outside, planted, 'junction');
  let outputDir;
  const pageId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const genpageCli = {
    download: async ({ outputDir: dir, pageIds }) => {
      outputDir = dir;
      fs.mkdirSync(path.join(dir, pageIds[0]), { recursive: true });
      fs.writeFileSync(path.join(dir, pageIds[0], 'page.tsx'), 'export const n = 1;\n', 'utf8');
    },
  };
  const sdk = { queryRecords: async () => [{ appmoduleid: 'app-1' }] };
  const reader = readerFor(sdk, 'contoso_app', { genpageCli, workspaceDir: ws });
  const code = await reader.pageCode(pageId);
  assert.equal(code, 'export const n = 1;\n');
  assert.equal(fs.readFileSync(path.join(outside, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(outside, pageId)), false, 'the junction target gained no page directory');
  assert.equal(fs.lstatSync(planted).isSymbolicLink(), true);
  assert.ok(outputDir && !outputDir.toLowerCase().includes('verify-pages'), outputDir);
  assert.equal(fs.existsSync(outputDir), false, 'the private download directory is removed');
});

test('download installs pac bytes unchanged, and refuses a link at the destination page', async (t) => {
  const base = tmp();
  const out = path.join(base, 'out');
  fs.mkdirSync(out);
  const pageId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const tsx = Buffer.from('export const n = 1;\r\n', 'utf8');
  const config = Buffer.concat([bom, Buffer.from('{"dataSources":[]}\r\n', 'utf8')]);
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, pages: [{ pageId, name: 'Overview' }] }),
    download: async ({ outputDir }) => {
      const dir = path.join(outputDir, pageId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'page.tsx'), tsx);
      fs.writeFileSync(path.join(dir, 'config.json'), config);
    },
  };
  const res = await runDownload({ sdk: pageSdk(), genpageCli, outDir: out, appId: APP_ID, appUnique: APP_UNIQUE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(fs.readFileSync(path.join(out, 'pages', pageId, 'page.tsx')), tsx);
  assert.deepEqual(fs.readFileSync(path.join(out, 'pages', pageId, 'config.json')), config);

  const linked = tmp('linked-dest');
  fs.mkdirSync(path.join(linked, 'pages'), { recursive: true });
  const outsideDir = path.join(linked, 'outside-id');
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'marker'), KEEP);
  fs.symlinkSync(outsideDir, path.join(linked, 'pages', pageId), 'junction');
  await assert.rejects(
    () => runDownload({ sdk: pageSdk(), genpageCli, outDir: linked, appId: APP_ID, appUnique: APP_UNIQUE }),
    /symbolic link or junction/,
  );
  assert.equal(fs.readFileSync(path.join(outsideDir, 'marker'), 'utf8'), KEEP);
  assert.equal(fs.existsSync(path.join(outsideDir, 'page.tsx')), false);

  const fileOut = tmp('file-link-dest');
  fs.mkdirSync(path.join(fileOut, 'pages', pageId), { recursive: true });
  const outsideFilePath = path.join(fileOut, 'outside.tsx');
  fs.writeFileSync(outsideFilePath, KEEP);
  const planted = path.join(fileOut, 'pages', pageId, 'page.tsx');
  if (!tryLink(t, outsideFilePath, planted, 'file')) return;
  await assert.rejects(
    () => runDownload({ sdk: pageSdk(), genpageCli, outDir: fileOut, appId: APP_ID, appUnique: APP_UNIQUE }),
    /symbolic link or junction|refusing to write/,
  );
  assert.equal(fs.readFileSync(outsideFilePath, 'utf8'), KEEP);
  assert.equal(fs.lstatSync(planted).isSymbolicLink(), true);
});

test('a folder at build-log.jsonl is the journal\'s best-effort case, not a refusal before the build', async () => {
  const base = tmp();
  const specPath = buildSpec(base);
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, 'build-log.jsonl'), { recursive: true });
  let factoryCalls = 0;
  let authCalls = 0;
  const cli = loadCli(BUILD_CLI, {
    argv: ['--env', ENV, '--spec', '@' + specPath, '--workspace', ws, '--apply', '--no-live-plan'],
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': {
        ...realAuth,
        preflightAuth: async () => { authCalls += 1; return { ok: true }; },
        emitResult: (ok, payload) => {
          const err = new Error(payload instanceof Error ? payload.message : (payload && (payload.error || payload.message)) || String(payload));
          err.exitCode = ok ? 0 : 1;
          throw err;
        },
      },
      './vendor/cds-maker-sdk.cjs': {
        createMakerSdk: () => { factoryCalls += 1; throw new Error('stop after the preflight'); },
        createNodeWorkspaceStorage: (dir) => ({ dir }),
      },
      // Offline: the real language resolution acquires a token for the environment.
      './lib/entity-provision.js': {
        ...require('../lib/entity-provision.js'),
        resolveAuthoringLanguage: async () => 1033,
      },
    },
  });
  let halted = null;
  try { await cli.main(); } catch (e) { halted = e; }
  assert.equal(authCalls, 1, 'the preflight let the build reach authentication');
  assert.ok(factoryCalls >= 1, 'and the SDK factory');
  assert.doesNotMatch((halted && halted.message) || '', /not a regular file|could not be inspected/);
});

test('build refuses a link at build-log.jsonl before the SDK factory runs', async (t) => {
  const base = tmp();
  const specPath = buildSpec(base);
  const ws = path.join(base, 'ws');
  fs.mkdirSync(ws);
  const outside = outsideFile(base, 'outside-log.jsonl');
  const log = path.join(ws, 'build-log.jsonl');
  if (!tryLink(t, outside, log, 'file')) return;
  let factoryCalls = 0;
  const cli = loadBuild(
    ['--env', ENV, '--spec', '@' + specPath, '--workspace', ws, '--apply', '--no-live-plan'],
    () => { factoryCalls += 1; return { initWorkspace: async () => {} }; },
  );
  let halted = null;
  try { await cli.main(); } catch (e) { halted = e; }
  assert.equal(factoryCalls, 0, 'SDK factory must not run');
  assert.equal(halted && halted.exitCode, 1);
  assert.match((halted && halted.message) || '', /symbolic link or junction|hard link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), KEEP);
  assert.equal(fs.lstatSync(log).isSymbolicLink(), true);
});

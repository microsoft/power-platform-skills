'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateAppSpec } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { webResourceOpts, runSdkBuild } = require('../lib/sdk-build.js');
const { pageSourceFileErrors, webResourceSourceFileErrors, appSourceFileErrors } = require('../lib/content-hash.js');
const { confinedReader } = require('../lib/deployed-baseline.js');
const { resolveAppSource } = require('../lib/app-source-path.js');

function specWithSource(file) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoSources', publisherPrefix: 'contoso' },
    app: { name: 'Contoso Sources', uniqueName: 'contoso_sources' },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item',
      primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
    }],
    pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: file } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview' }] }] }] },
    webResources: [{ name: 'contoso_source.js', type: 'js', contentPath: file }],
  };
}

function files(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-sources-'));
  const appDir = path.join(root, 'app');
  const outside = path.join(root, 'outside.tsx');
  fs.mkdirSync(appDir);
  fs.writeFileSync(outside, 'export default () => <div>Outside</div>;');
  fs.writeFileSync(path.join(appDir, 'page.tsx'), 'export default () => <div>Inside</div>;');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, appDir, outside };
}

const externalPaths = [
  '../outside.tsx', '..\\outside.tsx', 'pages/../../outside.tsx',
  '/outside.tsx', '\\outside.tsx', 'C:\\outside.tsx', 'D:..\\outside.tsx', 'D:page.tsx',
  '\\\\contoso\\share\\outside.tsx', '//contoso/share/outside.tsx',
  '\\\\?\\C:\\outside.tsx', '\\\\.\\C:\\outside.tsx', 'page.tsx:extra',
];

for (const file of externalPaths) {
  test(`validation confines web-resource contentPath ${JSON.stringify(file)}`, () => {
    for (const profile of ['design', 'plan', 'deploy']) {
      const result = validateAppSpec(specWithSource(file), { profile });
      assert.ok(result.errors.some((e) => /contentPath/.test(e)), `${profile}: ${JSON.stringify(result.errors)}`);
    }
  });

  // Teardown reads no source, so a spec an earlier release accepted must still tear down; and a path behind
  // inline content is never read (webResourceOpts precedence), so it is not the build's to refuse either.
  test(`teardown's structural profile and inline content leave an unread contentPath ${JSON.stringify(file)} alone`, () => {
    const structural = validateAppSpec(specWithSource(file), { profile: 'structural' });
    assert.ok(!structural.errors.some((e) => /contentPath/.test(e)), JSON.stringify(structural.errors));
    for (const inline of [{ content: 'var a;' }, { content: '' }, { contentBase64: 'aGk=' }]) {
      const spec = specWithSource(file);
      Object.assign(spec.webResources[0], inline);
      for (const profile of ['design', 'plan', 'deploy']) {
        const result = validateAppSpec(spec, { profile });
        assert.ok(!result.errors.some((e) => /contentPath/.test(e)), `${profile} ${JSON.stringify(inline)}: ${JSON.stringify(result.errors)}`);
      }
      assert.ok(!lintAppSpec(spec).errors.some((e) => /contentPath/.test(e)), `lint ${JSON.stringify(inline)}`);
    }
  });

  test(`validation confines page codeFile ${JSON.stringify(file)}`, () => {
    const result = validateAppSpec(specWithSource(file), { profile: 'deploy' });
    assert.ok(result.errors.some((e) => /codeFile.*relative path/.test(e)), JSON.stringify(result.errors));
  });

  test(`lint confines web-resource contentPath ${JSON.stringify(file)}`, () => {
    assert.ok(lintAppSpec(specWithSource(file)).errors.some((e) => /contentPath/.test(e)));
  });

  test(`source-file checks report ${JSON.stringify(file)} without inspecting it`, () => {
    let probes = 0;
    const errors = pageSourceFileErrors(specWithSource(file), 'C:\\contoso-app', {
      isFile: () => { probes++; return true; },
      realpath: (p) => p,
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /codeFile/);
    assert.equal(probes, 0, 'an external path must be refused before file inspection');
  });

  test(`resolver refuses ${JSON.stringify(file)} before filesystem inspection`, () => {
    let probes = 0;
    assert.throws(() => resolveAppSource('C:\\contoso-app', file, {
      lstat: () => { probes++; throw new Error('unexpected file inspection'); },
      realpath: () => { probes++; throw new Error('unexpected path inspection'); },
    }), { code: 'APP_SOURCE_PATH', reason: 'invalid-path' });
    assert.equal(probes, 0);
  });
}

test('validation and lint accept normalized relative source paths', () => {
  for (const file of ['page.tsx', './page.tsx', 'pages/../page.tsx', 'pages\\..\\page.tsx']) {
    assert.deepEqual(validateAppSpec(specWithSource(file), { profile: 'deploy' }).errors, []);
    assert.deepEqual(lintAppSpec(specWithSource(file)).errors, []);
  }
});

test('page source aliases collide under POSIX validation just as they do on Windows', (t) => {
  t.mock.method(path, 'normalize', path.posix.normalize);
  const s = specWithSource('page.tsx');
  s.pages.push({ key: 'alias', name: 'Contoso Alias', source: { kind: 'tsx', codeFile: 'pages\\..\\page.tsx' } });
  s.appShell.areas[0].groups[0].subAreas.push({ page: 'alias' });
  assert.ok(validateAppSpec(s, { profile: 'deploy' }).errors.some((e) => /duplicate codeFile/.test(e)));
});

test('web-resource reads refuse absolute and parent-relative outside files', (t) => {
  const { appDir, outside } = files(t);
  for (const contentPath of [outside, '../outside.tsx', '..\\outside.tsx']) {
    assert.throws(() => webResourceOpts({ name: 'contoso_source.js', contentPath }, appDir), /relative path|outside|confined/);
  }
});

test('web-resource uploads refuse outside sources before creating a resource', async (t) => {
  const { appDir, outside } = files(t);
  const created = [];
  const sdk = {
    queryRecords: async () => [],
    createWebResource: async (o) => { created.push(o); return { id: 'resource-created' }; },
    addSolutionComponent: async () => {},
  };
  await assert.rejects(runSdkBuild(specWithSource(outside), {
    sdk, provisionSdk: sdk, apply: true, phases: ['web-resources'], appDir,
  }), /relative path|outside|confined/);
  assert.deepEqual(created, []);
});

function linkFile(t, target, link, type = 'file') {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (e) {
    if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    t.skip('file links are not available to this test process');
    return false;
  }
}

test('all source readers refuse a file link to outside the app folder', (t) => {
  const { appDir, outside } = files(t);
  if (!linkFile(t, outside, path.join(appDir, 'linked.tsx'))) return;
  assert.throws(() => webResourceOpts({ name: 'contoso_source.js', contentPath: 'linked.tsx' }, appDir), /link|outside/);
  assert.equal(confinedReader(appDir)('linked.tsx'), null);
  assert.match(pageSourceFileErrors(specWithSource('linked.tsx'), appDir)[0], /link|outside/);
  assert.match(webResourceSourceFileErrors(specWithSource('linked.tsx'), appDir)[0], /^webResource 'contoso_source\.js': contentPath 'linked\.tsx' .*(link|outside)/);
});

test('source readers refuse a directory junction to outside the app folder', (t) => {
  const { root, appDir } = files(t);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'page.tsx'), 'export default () => null;');
  if (!linkFile(t, elsewhere, path.join(appDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  assert.throws(() => webResourceOpts({ name: 'contoso_source.js', contentPath: 'linked/page.tsx' }, appDir), /link|outside/);
  assert.equal(confinedReader(appDir)('linked/page.tsx'), null);
  assert.match(pageSourceFileErrors(specWithSource('linked/page.tsx'), appDir)[0], /link|outside/);
  assert.match(webResourceSourceFileErrors(specWithSource('linked/page.tsx'), appDir)[0], /^webResource 'contoso_source\.js': contentPath 'linked\/page\.tsx' .*(link|outside)/);
});

test('source readers refuse an in-folder link instead of accepting a second source identity', (t) => {
  const { appDir } = files(t);
  if (!linkFile(t, path.join(appDir, 'page.tsx'), path.join(appDir, 'alias.tsx'))) return;
  assert.throws(() => webResourceOpts({ name: 'contoso_source.js', contentPath: 'alias.tsx' }, appDir), /link/);
  assert.equal(confinedReader(appDir)('alias.tsx'), null);
  assert.match(pageSourceFileErrors(specWithSource('alias.tsx'), appDir)[0], /link/);
  assert.match(webResourceSourceFileErrors(specWithSource('alias.tsx'), appDir)[0], /contentPath 'alias\.tsx' .*link/);
});

test('source readers accept regular hard-linked files inside the app folder', (t) => {
  const { appDir, outside } = files(t);
  fs.linkSync(outside, path.join(appDir, 'linked.tsx'));
  const content = fs.readFileSync(outside, 'utf8');
  assert.equal(webResourceOpts({ name: 'contoso_source.js', contentPath: 'linked.tsx' }, appDir).content, content);
  assert.equal(String(confinedReader(appDir)('linked.tsx')), content);
  assert.deepEqual(pageSourceFileErrors(specWithSource('linked.tsx'), appDir), []);
  assert.deepEqual(webResourceSourceFileErrors(specWithSource('linked.tsx'), appDir), []);
});

test('a canonical source alias is not a link merely because realpath expands its spelling', () => {
  const root = path.resolve('contoso-alias-app');
  const absolute = path.join(root, 'LONGSO~1', 'CONTOS~1.TSX');
  const expanded = path.join(root, 'Long source folder', 'Contoso component.tsx');
  assert.equal(resolveAppSource(root, path.relative(root, absolute), {
    lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    readlink: () => { throw Object.assign(new Error('plain file'), { code: 'EINVAL' }); },
    realpath: (p) => p === root ? root : expanded,
  }), expanded);
});

test('Windows 8.3 folder and file aliases resolve to an ordinary source file', { skip: process.platform !== 'win32' && 'Windows short names only' }, (t) => {
  const { appDir } = files(t);
  const folder = path.join(appDir, 'Long source folder');
  const file = path.join(folder, 'Contoso component.tsx');
  fs.mkdirSync(folder);
  fs.writeFileSync(file, 'export default () => null;');
  const { execFileSync } = require('node:child_process');
  const short = (p) => execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~snxI`], { encoding: 'utf8', windowsHide: true }).trim();
  const shortFolder = short(folder);
  const shortFile = short(file);
  if (!shortFolder.includes('~') || !shortFile.includes('~')) {
    t.skip('this volume does not provide 8.3 short names for the test files');
    return;
  }
  const relative = path.join(shortFolder, shortFile);
  assert.ok(fs.existsSync(path.join(appDir, relative)), 'the host must expose the alias');
  assert.equal(resolveAppSource(appDir, relative).toLowerCase(), fs.realpathSync.native(file).toLowerCase());
  assert.deepEqual(pageSourceFileErrors(specWithSource(relative), appDir), []);
});

test('readlink proves a directory link even when lstat does not flag it', () => {
  const root = path.resolve('contoso-link-app');
  assert.throws(() => resolveAppSource(root, path.join('alias', 'page.tsx'), {
    lstat: () => ({ isSymbolicLink: () => false, isFile: () => true }),
    readlink: () => path.join(root, 'actual'),
    realpath: (p) => p,
  }), { code: 'APP_SOURCE_PATH', reason: 'link' });
});

test('source reads retain inline content and ordinary in-folder files', (t) => {
  const { appDir } = files(t);
  const content = fs.readFileSync(path.join(appDir, 'page.tsx'), 'utf8');
  assert.equal(webResourceOpts({ name: 'contoso_source.js', contentPath: './page.tsx' }, appDir).content, content);
  assert.equal(String(confinedReader(appDir)('page.tsx')), content);
  assert.deepEqual(pageSourceFileErrors(specWithSource('page.tsx'), appDir), []);
  assert.deepEqual(appSourceFileErrors(specWithSource('page.tsx'), appDir), []);
  assert.equal(webResourceOpts({ name: 'contoso_inline.js', content: 'inline', contentPath: '../unused' }, appDir).content, 'inline');
  const inlineOnly = { ...specWithSource('page.tsx'), webResources: [{ name: 'contoso_inline.js', type: 'js', content: 'inline' }] };
  assert.deepEqual(webResourceSourceFileErrors(inlineOnly, appDir), [], 'inline content needs no file');
  // Inline content wins over contentPath in webResourceOpts, so a contentPath the build never reads is not refused.
  for (const inline of [{ content: 'inline' }, { content: '' }, { contentBase64: 'aGk=' }]) {
    const spec = { ...specWithSource('page.tsx'), webResources: [{ name: 'contoso_inline.js', type: 'js', contentPath: 'missing.js', ...inline }] };
    assert.deepEqual(webResourceSourceFileErrors(spec, appDir), [], JSON.stringify(inline));
    assert.equal(webResourceOpts(spec.webResources[0], appDir).contentPath, undefined);
  }
});

test('source-file checks report missing files and directory sources', (t) => {
  const { appDir } = files(t);
  fs.mkdirSync(path.join(appDir, 'folder'));
  for (const file of ['missing.tsx', 'folder']) {
    assert.match(pageSourceFileErrors(specWithSource(file), appDir)[0], /does not exist or is not a file/);
    assert.match(webResourceSourceFileErrors(specWithSource(file), appDir)[0], new RegExp(`^webResource 'contoso_source\\.js': contentPath '${file.replace('.', '\\.')}' does not exist or is not a file`));
  }
  // appSourceFileErrors is the gate the build and lint run: both kinds, pages first.
  const both = appSourceFileErrors(specWithSource('missing.tsx'), appDir);
  assert.equal(both.length, 2);
  assert.match(both[0], /^page 'overview'/);
  assert.match(both[1], /^webResource 'contoso_source\.js'/);
});

test('an unconfined contentPath is a schema error only, not reported again by the file check', (t) => {
  const { appDir } = files(t);
  for (const file of externalPaths) {
    assert.deepEqual(webResourceSourceFileErrors(specWithSource(file), appDir), [], file);
  }
});

test('page deployment refuses a linked source before any upload', async (t) => {
  const { appDir, outside } = files(t);
  if (!linkFile(t, outside, path.join(appDir, 'linked.tsx'))) return;
  const uploads = [];
  const sdk = {
    queryRecords: async (entity) => {
      if (entity === 'appmodule') return [{ appmoduleid: 'app-id', appmoduleidunique: 'app-layer', uniquename: 'contoso_sources' }];
      if (entity === 'appmodulecomponent') return [{ objectid: 'sitemap-id', componenttype: 62 }];
      if (entity === 'sitemap') return [{ sitemapxml: '<SiteMap />' }];
      return [];
    },
    createWebResource: async () => ({ id: 'manifest-id' }),
    addSolutionComponent: async () => {},
  };
  await assert.rejects(runSdkBuild(specWithSource('linked.tsx'), {
    sdk, provisionSdk: sdk, apply: true, appDir, phases: ['pages'],
    changedOnly: { resolvedAppId: 'app-id', selectedKeys: ['overview'], skipSitemapFinalize: true },
    genpageCli: {
      enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
      upload: async (o) => { uploads.push(o); return { pageId: 'page-created' }; },
    },
  }), /link|outside/);
  assert.deepEqual(uploads, []);
});

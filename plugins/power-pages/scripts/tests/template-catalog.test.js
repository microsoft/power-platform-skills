'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  buildRawUrl,
  buildCommitUrl,
  buildLatestReleaseUrl,
  cacheDirForSha,
  artifactCachePath,
  requestJson,
  downloadFile,
  fetchCatalog,
  downloadArtifact,
  downloadSolutionArtifact,
  downloadSeedDataDirectory,
  validateZipContainsSolution,
  validateCatalogShape,
  assertValidSha,
  resolveRefToSha,
} = require('../lib/template-catalog');
const { parseArgs: parseCatalogArgs } = require('../fetch-template-catalog');
const { parseArgs: parseSolutionArgs } = require('../fetch-template-solution');
const { parseArgs: parseArtifactArgs } = require('../fetch-template-artifact');
const { parseArgs: parseSeedArgs } = require('../fetch-template-seed-data');
const { parseTemplateRepoArgs, formatJsonResult, runBestEffortJsonCli } = require('../lib/template-cli-args');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'template-catalog-test-'));
}

const SHA = '1234567890abcdef1234567890abcdef12345678';
const VALID_TEMPLATE = {
  id: 'company-portal',
  displayName: 'Company Portal',
  description: 'Internal portal',
  kind: 'spa',
  framework: 'react',
  keywords: ['portal'],
  audience: ['makers', 'developers'],
  requiredDataverseLanguages: [1033],
  previewImages: ['templates/spa/company-portal/previews/home.png'],
  solutionPath: 'templates/spa/company-portal/solution/Company_1_0_0_0.zip',
  templateVersion: '1.0.0',
  author: 'Microsoft',
};

test('builds raw and commit URLs from repo, ref and template-relative paths', () => {
  assert.equal(
    buildCommitUrl({ owner: 'microsoft', repo: 'power-pages-samples', ref: 'release/v1' }),
    'https://api.github.com/repos/microsoft/power-pages-samples/commits/release%2Fv1'
  );
  assert.equal(
    buildLatestReleaseUrl({ owner: 'microsoft', repo: 'power-pages-samples' }),
    'https://api.github.com/repos/microsoft/power-pages-samples/releases/latest'
  );
  assert.equal(
    buildRawUrl({ owner: 'microsoft', repo: 'power-pages-samples', sha: SHA, filePath: 'templates/spa/hr portal/manifest.json' }),
    `https://raw.githubusercontent.com/microsoft/power-pages-samples/${SHA}/templates/spa/hr%20portal/manifest.json`
  );
});

test('rejects non-commit refs where a pinned sha is required', () => {
  assert.throws(() => assertValidSha('main'), /Expected an immutable 40-character commit sha/);
  assert.throws(
    () => buildRawUrl({ owner: 'o', repo: 'r', sha: '../escape', filePath: 'templates/manifest.json' }),
    /Expected an immutable 40-character commit sha/
  );
});

test('resolveRefToSha falls back to git ls-remote when the GitHub commit API is rate limited', async () => {
  const seen = [];
  const sha = await resolveRefToSha({ owner: 'o', repo: 'r', ref: 'main' }, {
    requestJson: async () => {
      throw new Error('GET https://api.github.com/repos/o/r/commits/main failed with 403');
    },
    execFileSync: (cmd, args) => {
      seen.push([cmd, args]);
      return `${SHA}\trefs/heads/main\n`;
    },
  });

  assert.equal(sha, SHA);
  assert.deepEqual(seen, [['git', ['ls-remote', 'https://github.com/o/r.git', 'main']]]);
});

test('fetchCatalog resolves the latest release to a sha, fetches the catalog at that sha, and creates a sha cache dir', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const catalog = { manifestVersion: '1.0', templates: [VALID_TEMPLATE] };

  const result = await fetchCatalog({ owner: 'o', repo: 'r', cacheRoot: dir }, {
    requestJson: async (url) => {
      seen.push(url);
      if (url === 'https://api.github.com/repos/o/r/releases/latest') {
        return { tag_name: 'templates-v1.0.0', name: 'Templates v1.0.0', html_url: 'https://example.test/release' };
      }
      if (url === 'https://api.github.com/repos/o/r/commits/templates-v1.0.0') return { sha: SHA };
      if (url === `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`) return catalog;
      throw new Error(`unexpected url: ${url}`);
    },
  });

  assert.deepEqual(result, {
    ok: true,
    owner: 'o',
    repo: 'r',
    ref: 'latest-release',
    resolvedRef: 'templates-v1.0.0',
    sha: SHA,
    releaseName: 'Templates v1.0.0',
    releaseUrl: 'https://example.test/release',
    catalogPath: 'templates/manifest.json',
    catalogLocalPath: path.join(dir, SHA, 'templates/manifest.json'),
    cacheDir: path.join(dir, SHA),
    catalog,
  });
  assert.deepEqual(seen, [
    'https://api.github.com/repos/o/r/releases/latest',
    'https://api.github.com/repos/o/r/commits/templates-v1.0.0',
    `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`,
  ]);
  assert.equal(fs.existsSync(path.join(dir, SHA)), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SHA, 'templates/manifest.json'), 'utf8')), catalog);
});

test('fetchCatalog resolves manifest artifact paths relative to the catalog folder', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalog = {
    manifestVersion: '1.0',
    templates: [{
      ...VALID_TEMPLATE,
      previewImages: ['spa/company-portal/previews/home.png', 'templates/spa/company-portal/previews/already-rooted.png'],
      solutionPath: 'spa/company-portal/solution/Company_1_0_0_0.zip',
      seedDataPath: 'spa/company-portal/seed/data.json',
    }],
  };

  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'templates-v1.0.0', cacheRoot: dir }, {
    requestJson: async (url) => {
      if (url === 'https://api.github.com/repos/o/r/commits/templates-v1.0.0') return { sha: SHA };
      if (url === `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`) return catalog;
      throw new Error(`unexpected url: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.catalog.templates[0].previewImages, [
    'templates/spa/company-portal/previews/home.png',
    'templates/spa/company-portal/previews/already-rooted.png',
  ]);
  assert.equal(result.catalog.templates[0].solutionPath, 'templates/spa/company-portal/solution/Company_1_0_0_0.zip');
  assert.equal(result.catalog.templates[0].seedDataPath, 'templates/spa/company-portal/seed/data.json');
});

test('fetchCatalog falls back to main when the samples repo has no latest release yet', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalog = { manifestVersion: '1.0', templates: [VALID_TEMPLATE] };
  const seen = [];

  const result = await fetchCatalog({ owner: 'o', repo: 'r', cacheRoot: dir }, {
    requestJson: async (url) => {
      seen.push(url);
      if (url === 'https://api.github.com/repos/o/r/releases/latest') {
        throw new Error('GET https://api.github.com/repos/o/r/releases/latest failed with 404');
      }
      if (url === 'https://api.github.com/repos/o/r/commits/main') return { sha: SHA };
      if (url === `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`) return catalog;
      throw new Error(`unexpected url: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ref, 'latest-release');
  assert.equal(result.resolvedRef, 'main');
  assert.deepEqual(seen, [
    'https://api.github.com/repos/o/r/releases/latest',
    'https://api.github.com/repos/o/r/commits/main',
    `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`,
  ]);
});

test('fetchCatalog falls back to main when latest release lookup is rate limited', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalog = { manifestVersion: '1.0', templates: [VALID_TEMPLATE] };

  const result = await fetchCatalog({ owner: 'o', repo: 'r', cacheRoot: dir }, {
    requestJson: async (url) => {
      if (url === 'https://api.github.com/repos/o/r/releases/latest') {
        throw new Error('GET https://api.github.com/repos/o/r/releases/latest failed with 403');
      }
      if (url === 'https://api.github.com/repos/o/r/commits/main') return { sha: SHA };
      if (url === `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`) return catalog;
      throw new Error(`unexpected url: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolvedRef, 'main');
});

test('fetchCatalog still accepts an explicit ref override for tests or pinned rollouts', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalog = { manifestVersion: '1.0', templates: [VALID_TEMPLATE] };
  const seen = [];

  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'templates-v0.9.0', cacheRoot: dir }, {
    requestJson: async (url) => {
      seen.push(url);
      if (url === 'https://api.github.com/repos/o/r/commits/templates-v0.9.0') return { sha: SHA };
      if (url === `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`) return catalog;
      throw new Error(`unexpected url: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ref, 'templates-v0.9.0');
  assert.equal(result.resolvedRef, 'templates-v0.9.0');
  assert.deepEqual(seen, [
    'https://api.github.com/repos/o/r/commits/templates-v0.9.0',
    `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`,
  ]);
});

test('fetchCatalog returns ok:false so create-site can fall back when the catalog is unreachable', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'main', cacheRoot: dir }, {
    requestJson: async (url) => {
      if (url === 'https://api.github.com/repos/o/r/commits/main') return { sha: SHA };
      throw new Error('network unavailable');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.owner, 'o');
  assert.equal(result.repo, 'r');
  assert.equal(result.ref, 'main');
  assert.match(result.error, /network unavailable/);
  assert.equal(fs.existsSync(path.join(dir, SHA)), false, 'failed catalog fetch must not leave a sha cache dir');
});

test('fetchCatalog treats malformed catalogs as ok:false without creating a sha cache dir', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'main', cacheRoot: dir }, {
    requestJson: async (url) => {
      if (url === 'https://api.github.com/repos/o/r/commits/main') return { sha: SHA };
      return { manifestVersion: '1.0' };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /malformed/);
  assert.equal(fs.existsSync(path.join(dir, SHA)), false, 'malformed catalog must not leave a sha cache dir');
});

test('fetchCatalog treats malformed template entries as ok:false without creating a sha cache dir', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'main', cacheRoot: dir }, {
    requestJson: async (url) => {
      if (url === 'https://api.github.com/repos/o/r/commits/main') return { sha: SHA };
      return { manifestVersion: '1.0', templates: [{ id: 'missing-fields' }] };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /missing string field/);
  assert.equal(fs.existsSync(path.join(dir, SHA)), false, 'malformed entries must not leave a sha cache dir');
});

test('validateCatalogShape accepts a complete template entry and rejects broken entries', () => {
  assert.equal(validateCatalogShape({ templates: [VALID_TEMPLATE] }), null);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, previewImages: [] }] }), /previewImages/);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, keywords: 'portal' }] }), /keywords/);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, requiredDataverseLanguages: [] }] }), /requiredDataverseLanguages/);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, requiredDataverseLanguages: ['1033'] }] }), /requiredDataverseLanguages/);
});

// Regression: the published manifest declares `audience` as an array of personas
// (see templates/schemas/templates-manifest.schema.json in power-pages-samples).
// An earlier validator required a plain string, which rejected every real
// template and silently forced create-site down the from-scratch path.
test('validateCatalogShape accepts the 311 Portal audience array and rejects non-array shapes', () => {
  const portal311 = {
    ...VALID_TEMPLATE,
    id: '311-portal',
    displayName: '311 Portal',
    description: 'Citizen service request portal',
    keywords: ['311', 'citizen-services'],
    audience: ['makers', 'developers'],
    previewImages: ['spa/311-portal/previews/home.png'],
    solutionPath: 'spa/311-portal/solution/311-portal-unmanaged.zip',
    templateVersion: '1.0.0.1',
  };

  assert.equal(validateCatalogShape({ templates: [portal311] }), null);
  assert.match(
    validateCatalogShape({ templates: [{ ...portal311, audience: 'internal' }] }),
    /audience must be a non-empty array of strings/,
  );
  assert.match(validateCatalogShape({ templates: [{ ...portal311, audience: [] }] }), /audience/);
  assert.match(validateCatalogShape({ templates: [{ ...portal311, audience: ['makers', ''] }] }), /audience/);
});

test('requestJson uses an injected https boundary and parses response JSON', async () => {
  const fakeHttps = {
    get(url, options, callback) {
      assert.equal(url, 'https://example.test/catalog.json');
      assert.equal(options.headers['User-Agent'], 'power-pages-template-catalog');
      const req = new EventEmitter();
      req.destroy = (err) => req.emit('error', err);
      process.nextTick(() => {
        const res = new PassThrough();
        res.statusCode = 200;
        callback(res);
        res.end('{"templates":[{"id":"portal"}]}');
      });
      return req;
    },
  };

  assert.deepEqual(await requestJson('https://example.test/catalog.json', { https: fakeHttps }), {
    templates: [{ id: 'portal' }],
  });
});

test('downloadFile streams through injected https and fs boundaries', async () => {
  const writes = [];
  let renamed = null;
  const fakeFs = {
    mkdirSync(dir) { writes.push(['mkdir', dir]); },
    createWriteStream(dest) {
      writes.push(['stream', dest]);
      const stream = new PassThrough();
      stream.close = (callback) => callback();
      return stream;
    },
    renameSync(from, to) { renamed = [from, to]; },
    rmSync() {},
  };
  const fakeHttps = {
    get(url, options, callback) {
      assert.equal(url, 'https://example.test/template.zip');
      assert.equal(options.headers['User-Agent'], 'power-pages-template-catalog');
      const req = new EventEmitter();
      req.destroy = (err) => req.emit('error', err);
      process.nextTick(() => {
        const res = new PassThrough();
        res.statusCode = 200;
        callback(res);
        res.end(Buffer.from([0x50, 0x4b]));
      });
      return req;
    },
  };

  const output = await downloadFile('https://example.test/template.zip', '/cache/template.zip', {
    fs: fakeFs,
    https: fakeHttps,
  });

  assert.equal(output, '/cache/template.zip');
  assert.deepEqual(writes, [['mkdir', '/cache'], ['stream', '/cache/template.zip.partial']]);
  assert.deepEqual(renamed, ['/cache/template.zip.partial', '/cache/template.zip']);
});

test('downloadArtifact caches artifacts under the pinned sha and skips download when already cached', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifactPath = 'templates/spa/company/solution/Company_1_0_0_0.zip';
  const expectedPath = artifactCachePath({ cacheRoot: dir, sha: SHA, artifactPath });
  let downloads = 0;

  const first = await downloadArtifact({ owner: 'o', repo: 'r', sha: SHA, artifactPath, cacheRoot: dir }, {
    downloadFile: async (url, dest) => {
      downloads++;
      assert.equal(url, `https://raw.githubusercontent.com/o/r/${SHA}/${artifactPath}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'zip-bytes');
    },
  });

  const second = await downloadArtifact({ owner: 'o', repo: 'r', sha: SHA, artifactPath, cacheRoot: dir }, {
    downloadFile: async () => { throw new Error('must not download cached artifact'); },
  });

  assert.deepEqual(first, { localPath: expectedPath, cached: false });
  assert.deepEqual(second, { localPath: expectedPath, cached: true });
  assert.equal(downloads, 1);
});

test('artifactCachePath rejects paths that escape the sha cache directory', () => {
  assert.throws(
    () => artifactCachePath({ cacheRoot: '/tmp/cache', sha: SHA, artifactPath: '../secret.zip' }),
    /must stay under the templates cache/
  );
  assert.throws(
    () => artifactCachePath({ cacheRoot: '/tmp/cache', sha: SHA, artifactPath: '/tmp/secret.zip' }),
    /must stay under the templates cache/
  );
});

test('downloadSolutionArtifact fails open and removes invalid zips instead of leaving corrupt cache entries', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const artifactPath = 'templates/spa/company/solution/Company_1_0_0_0.zip';
  const expectedPath = artifactCachePath({ cacheRoot: dir, sha: SHA, artifactPath });

  const result = await downloadSolutionArtifact({ owner: 'o', repo: 'r', sha: SHA, artifactPath, cacheRoot: dir }, {
    downloadFile: async (_url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'not a solution');
    },
    validateZipContainsSolution: () => false,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /not a valid Dataverse solution zip/);
  assert.equal(fs.existsSync(expectedPath), false);
});

test('downloadSolutionArtifact reports download failures as ok:false for from-scratch fallback', async () => {
  const result = await downloadSolutionArtifact({ owner: 'o', repo: 'r', sha: SHA, artifactPath: 'missing.zip' }, {
    downloadFile: async () => { throw new Error('404'); },
  });

  assert.deepEqual(result, { ok: false, artifactPath: 'missing.zip', error: '404' });
});

test('downloadSeedDataDirectory discovers JSON files from the pinned tree and caches them', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const downloaded = [];
  const result = await downloadSeedDataDirectory({
    owner: 'o',
    repo: 'r',
    sha: SHA,
    seedDataPath: 'templates/spa/company/seed-data',
    cacheRoot: dir,
  }, {
    requestJson: async (url) => {
      assert.equal(url, `https://api.github.com/repos/o/r/git/trees/${SHA}?recursive=1`);
      return {
        tree: [
          { type: 'blob', path: 'templates/spa/company/seed-data/020-posts.json' },
          { type: 'blob', path: 'templates/spa/company/seed-data/files/invoice.pdf' },
          { type: 'blob', path: 'templates/spa/company/README.md' },
          { type: 'blob', path: 'templates/spa/company/seed-data/010-categories.json' },
        ],
      };
    },
    downloadFile: async (_url, dest) => {
      downloaded.push(path.basename(dest));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, '{}');
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(downloaded, ['010-categories.json', '020-posts.json', 'invoice.pdf']);
  assert.equal(result.localDir, path.join(dir, SHA, 'templates/spa/company/seed-data'));
});

test('fetch-template-seed-data CLI parser accepts seed data path', () => {
  assert.deepEqual(parseSeedArgs([
    '--owner', 'contoso',
    '--repo', 'samples',
    '--sha', SHA,
    '--seedDataPath', 'templates/spa/company/seed-data',
    '--cacheRoot', '/tmp/cache',
  ]), {
    owner: 'contoso',
    repo: 'samples',
    sha: SHA,
    seedDataPath: 'templates/spa/company/seed-data',
    cacheRoot: '/tmp/cache',
  });
});

test('validateZipContainsSolution recognizes solution.xml in unzip output', () => {
  assert.equal(validateZipContainsSolution('/tmp/ok.zip', {
    execFileSync: () => '      123  01-01-2026 00:00   solution.xml\n',
  }), true);
  assert.equal(validateZipContainsSolution('/tmp/nope.zip', {
    execFileSync: () => '      123  01-01-2026 00:00   customizations.xml\n',
  }), false);
  assert.equal(validateZipContainsSolution('/tmp/broken.zip', {
    execFileSync: () => { throw new Error('not a zip'); },
  }), false);
});

test('fetch-template-catalog CLI parser accepts repo/ref/cache options', () => {
  assert.deepEqual(parseCatalogArgs([
    '--owner', 'contoso',
    '--repo', 'samples',
    '--ref', 'release/v1',
    '--catalogPath', 'templates/custom.json',
    '--cacheRoot', '/tmp/cache',
  ]), {
    owner: 'contoso',
    repo: 'samples',
    ref: 'release/v1',
    catalogPath: 'templates/custom.json',
    cacheRoot: '/tmp/cache',
  });
});

test('fetch-template-catalog CLI parser defaults ref to latest-release', () => {
  assert.equal(parseCatalogArgs([]).ref, 'latest-release');
});

test('fetch-template-solution CLI parser maps solutionPath to artifactPath', () => {
  assert.deepEqual(parseSolutionArgs([
    '--owner', 'contoso',
    '--repo', 'samples',
    '--sha', SHA,
    '--solutionPath', 'templates/spa/company/solution/Company_1_0_0_0.zip',
    '--cacheRoot', '/tmp/cache',
  ]), {
    owner: 'contoso',
    repo: 'samples',
    sha: SHA,
    artifactPath: 'templates/spa/company/solution/Company_1_0_0_0.zip',
    cacheRoot: '/tmp/cache',
  });
});

test('fetch-template-artifact CLI parser maps artifactPath to the shared artifact option', () => {
  assert.deepEqual(parseArtifactArgs([
    '--owner', 'contoso',
    '--repo', 'samples',
    '--sha', SHA,
    '--artifactPath', 'templates/spa/company/previews/home.png',
    '--cacheRoot', '/tmp/cache',
  ]), {
    owner: 'contoso',
    repo: 'samples',
    sha: SHA,
    artifactPath: 'templates/spa/company/previews/home.png',
    cacheRoot: '/tmp/cache',
  });
});

test('shared template CLI arg parser handles common repo/cache and path flags', () => {
  assert.deepEqual(parseTemplateRepoArgs([
    '--owner', 'contoso',
    '--repo', 'samples',
    '--ref', 'main',
    '--sha', SHA,
    '--cacheRoot', '/tmp/cache',
    '--solutionPath', 'templates/spa/company/solution.zip',
  ], '--solutionPath'), {
    owner: 'contoso',
    repo: 'samples',
    ref: 'main',
    sha: SHA,
    cacheRoot: '/tmp/cache',
    artifactPath: 'templates/spa/company/solution.zip',
  });
});

test('shared JSON CLI runner formats success and fail-open errors', async () => {
  const writes = [];
  const exits = [];
  await runBestEffortJsonCli(async () => ({ ok: true, value: 1 }), {
    stdout: { write: (value) => writes.push(value) },
    process: { exit: (code) => exits.push(code) },
  });
  await runBestEffortJsonCli(async () => { throw new Error('boom'); }, {
    stdout: { write: (value) => writes.push(value) },
    process: { exit: (code) => exits.push(code) },
  });

  assert.equal(formatJsonResult({ ok: true }), '{\n  "ok": true\n}\n');
  assert.deepEqual(exits, [0, 0]);
  assert.match(writes[0], /"value": 1/);
  assert.match(writes[1], /"ok": false/);
  assert.match(writes[1], /"error": "boom"/);
});

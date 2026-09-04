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
  buildGitRemoteUrl,
  cacheDirForSha,
  artifactCachePath,
  requestJson,
  downloadFile,
  fetchCatalog,
  downloadArtifact,
  downloadTemplateVariant,
  downloadSeedDataDirectory,
  validateZipContainsSolution,
  validateSpaCodeDirectory,
  validateSpaCodePath,
  templateVariantRoot,
  zipFileNames,
  validateCatalogShape,
  assertValidSha,
  resolveRefToSha,
  normalizeCatalogFamilies,
} = require('../lib/template-catalog');
const { parseArgs: parseCatalogArgs } = require('../fetch-template-catalog');
const { parseArgs: parseVariantArgs } = require('../fetch-template-variant');
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
  spaCodePath: 'templates/spa/company-portal/spa-code',
  templateVersion: '1.0.0',
  author: 'Microsoft',
};

const VALID_TEMPLATE_FAMILY = {
  id: 'supplier-portal',
  displayName: 'Supplier Portal',
  description: 'Supplier invoice portal',
  kind: 'spa',
  keywords: ['supplier', 'invoice'],
  audience: ['makers', 'developers'],
  requiredDataverseLanguages: [1033],
  previewImages: ['templates/spa/supplier-portal/previews/home.png'],
  seedDataPath: 'templates/spa/supplier-portal/seed-data/data.json',
  author: 'Microsoft',
  variants: {
    react: {
      templateVersion: '1.0.0',
      solutionPath: 'templates/spa/supplier-portal/variants/react/solution/SupplierReact.zip',
      spaCodePath: 'templates/spa/supplier-portal/variants/react/spa-code',
    },
    vue: {
      templateVersion: '1.0.1',
      solutionPath: 'templates/spa/supplier-portal/variants/vue/solution/SupplierVue.zip',
      spaCodePath: 'templates/spa/supplier-portal/variants/vue/spa-code',
      previewImages: ['templates/spa/supplier-portal/variants/vue/previews/home.png'],
    },
  },
};

function fakeZipWithLocalFile(name) {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes]);
}

test('builds raw and git remote URLs from repo and template-relative paths', () => {
  assert.equal(buildGitRemoteUrl({ owner: 'microsoft', repo: 'power-pages-samples' }), 'https://github.com/microsoft/power-pages-samples.git');
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

test('resolveRefToSha resolves refs with git ls-remote', async () => {
  const seen = [];
  const sha = resolveRefToSha({ owner: 'o', repo: 'r', ref: 'main' }, {
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
  const gitCalls = [];
  const catalog = { manifestVersion: '1.0', templates: [VALID_TEMPLATE] };

  const result = await fetchCatalog({ owner: 'o', repo: 'r', cacheRoot: dir }, {
    execFileSync: (cmd, args) => {
      gitCalls.push([cmd, args]);
      assert.deepEqual(args, ['ls-remote', '--tags', 'https://github.com/o/r.git']);
      return [
        `${'0'.repeat(40)}\trefs/tags/templates-v0.9.0`,
        `${SHA}\trefs/tags/templates-v1.0.0`,
      ].join('\n');
    },
    requestJson: async (url) => {
      seen.push(url);
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
    releaseName: 'templates-v1.0.0',
    releaseUrl: 'https://github.com/o/r/releases/tag/templates-v1.0.0',
    catalogPath: 'templates/manifest.json',
    catalogLocalPath: path.join(dir, SHA, 'templates/manifest.json'),
    cacheDir: path.join(dir, SHA),
    catalog,
  });
  assert.deepEqual(gitCalls, [['git', ['ls-remote', '--tags', 'https://github.com/o/r.git']]]);
  assert.deepEqual(seen, [
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
      spaCodePath: 'spa/company-portal/spa-code',
      seedDataPath: 'spa/company-portal/seed/data.json',
    }],
  };

  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'templates-v1.0.0', cacheRoot: dir }, {
    execFileSync: (cmd, args) => {
      assert.deepEqual([cmd, args], ['git', ['ls-remote', 'https://github.com/o/r.git', 'templates-v1.0.0']]);
      return `${SHA}\trefs/tags/templates-v1.0.0\n`;
    },
    requestJson: async (url) => {
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
  assert.equal(result.catalog.templates[0].spaCodePath, 'templates/spa/company-portal/spa-code');
  assert.equal(result.catalog.templates[0].seedDataPath, 'templates/spa/company-portal/seed/data.json');
});

test('validateCatalogShape accepts nested template families with framework variants', () => {
  assert.equal(validateCatalogShape({ manifestVersion: '2.0', templates: [VALID_TEMPLATE_FAMILY] }), null);
});

test('validateCatalogShape rejects duplicate framework variants in a family', () => {
  const family = {
    ...VALID_TEMPLATE_FAMILY,
    variants: {
      react: VALID_TEMPLATE_FAMILY.variants.react,
      React: VALID_TEMPLATE_FAMILY.variants.react,
    },
  };

  assert.match(
    validateCatalogShape({ templates: [family] }),
    /duplicate framework variant/i
  );
});

test('fetchCatalog materializes nested family and variant artifact paths', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalog = {
    manifestVersion: '2.0',
    templates: [{
      ...VALID_TEMPLATE_FAMILY,
      previewImages: ['spa/supplier-portal/previews/home.png'],
      seedDataPath: 'spa/supplier-portal/seed-data/data.json',
      variants: {
        react: {
          templateVersion: '1.0.0',
          solutionPath: 'spa/supplier-portal/variants/react/solution/SupplierReact.zip',
          spaCodePath: 'spa/supplier-portal/variants/react/spa-code',
        },
        vue: {
          templateVersion: '1.0.1',
          solutionPath: 'spa/supplier-portal/variants/vue/solution/SupplierVue.zip',
          spaCodePath: 'spa/supplier-portal/variants/vue/spa-code',
          previewImages: ['spa/supplier-portal/variants/vue/previews/home.png'],
          seedDataPath: 'spa/supplier-portal/variants/vue/seed-data/data.json',
        },
      },
    }],
  };

  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'templates-v2.0.0', cacheRoot: dir }, {
    execFileSync: () => `${SHA}\trefs/tags/templates-v2.0.0\n`,
    requestJson: async () => catalog,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.catalog.templates[0].previewImages, ['templates/spa/supplier-portal/previews/home.png']);
  assert.equal(result.catalog.templates[0].seedDataPath, 'templates/spa/supplier-portal/seed-data/data.json');
  assert.equal(result.catalog.templates[0].variants.react.solutionPath, 'templates/spa/supplier-portal/variants/react/solution/SupplierReact.zip');
  assert.equal(result.catalog.templates[0].variants.react.spaCodePath, 'templates/spa/supplier-portal/variants/react/spa-code');
  assert.deepEqual(result.catalog.templates[0].variants.vue.previewImages, ['templates/spa/supplier-portal/variants/vue/previews/home.png']);
  assert.equal(result.catalog.templates[0].variants.vue.seedDataPath, 'templates/spa/supplier-portal/variants/vue/seed-data/data.json');
});

test('normalizeCatalogFamilies exposes exact variant records with family metadata', () => {
  const families = normalizeCatalogFamilies({ templates: [VALID_TEMPLATE_FAMILY] });

  assert.deepEqual(families, [{
    id: 'supplier-portal',
    displayName: 'Supplier Portal',
    description: 'Supplier invoice portal',
    kind: 'spa',
    keywords: ['supplier', 'invoice'],
    audience: ['makers', 'developers'],
    requiredDataverseLanguages: [1033],
    previewImages: ['templates/spa/supplier-portal/previews/home.png'],
    seedDataPath: 'templates/spa/supplier-portal/seed-data/data.json',
    author: 'Microsoft',
    variants: [
      {
        familyId: 'supplier-portal',
        variantKey: 'react',
        variantId: 'supplier-portal/react',
        displayName: 'Supplier Portal',
        description: 'Supplier invoice portal',
        kind: 'spa',
        framework: 'react',
        keywords: ['supplier', 'invoice'],
        audience: ['makers', 'developers'],
        requiredDataverseLanguages: [1033],
        previewImages: ['templates/spa/supplier-portal/previews/home.png'],
        seedDataPath: 'templates/spa/supplier-portal/seed-data/data.json',
        templateVersion: '1.0.0',
        solutionPath: 'templates/spa/supplier-portal/variants/react/solution/SupplierReact.zip',
        spaCodePath: 'templates/spa/supplier-portal/variants/react/spa-code',
        author: 'Microsoft',
      },
      {
        familyId: 'supplier-portal',
        variantKey: 'vue',
        variantId: 'supplier-portal/vue',
        displayName: 'Supplier Portal',
        description: 'Supplier invoice portal',
        kind: 'spa',
        framework: 'vue',
        keywords: ['supplier', 'invoice'],
        audience: ['makers', 'developers'],
        requiredDataverseLanguages: [1033],
        previewImages: ['templates/spa/supplier-portal/variants/vue/previews/home.png'],
        seedDataPath: 'templates/spa/supplier-portal/seed-data/data.json',
        templateVersion: '1.0.1',
        solutionPath: 'templates/spa/supplier-portal/variants/vue/solution/SupplierVue.zip',
        spaCodePath: 'templates/spa/supplier-portal/variants/vue/spa-code',
        author: 'Microsoft',
      },
    ],
  }]);
});

test('fetchCatalog falls back to main when no semver tags exist yet', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalog = { manifestVersion: '1.0', templates: [VALID_TEMPLATE] };
  const seen = [];
  const gitCalls = [];

  const result = await fetchCatalog({ owner: 'o', repo: 'r', cacheRoot: dir }, {
    execFileSync: (cmd, args) => {
      gitCalls.push([cmd, args]);
      if (args[1] === '--tags') return '';
      assert.deepEqual(args, ['ls-remote', 'https://github.com/o/r.git', 'main']);
      return `${SHA}\trefs/heads/main\n`;
    },
    requestJson: async (url) => {
      seen.push(url);
      if (url === `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`) return catalog;
      throw new Error(`unexpected url: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ref, 'latest-release');
  assert.equal(result.resolvedRef, 'main');
  assert.deepEqual(gitCalls, [
    ['git', ['ls-remote', '--tags', 'https://github.com/o/r.git']],
    ['git', ['ls-remote', 'https://github.com/o/r.git', 'main']],
  ]);
  assert.deepEqual(seen, [
    `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`,
  ]);
});

test('fetchCatalog still accepts an explicit ref override for tests or pinned rollouts', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalog = { manifestVersion: '1.0', templates: [VALID_TEMPLATE] };
  const seen = [];

  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'templates-v0.9.0', cacheRoot: dir }, {
    execFileSync: (cmd, args) => {
      assert.deepEqual([cmd, args], ['git', ['ls-remote', 'https://github.com/o/r.git', 'templates-v0.9.0']]);
      return `${SHA}\trefs/tags/templates-v0.9.0\n`;
    },
    requestJson: async (url) => {
      seen.push(url);
      if (url === `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`) return catalog;
      throw new Error(`unexpected url: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.ref, 'templates-v0.9.0');
  assert.equal(result.resolvedRef, 'templates-v0.9.0');
  assert.deepEqual(seen, [
    `https://raw.githubusercontent.com/o/r/${SHA}/templates/manifest.json`,
  ]);
});

test('fetchCatalog returns ok:false so create-site can fall back when the catalog is unreachable', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await fetchCatalog({ owner: 'o', repo: 'r', ref: 'main', cacheRoot: dir }, {
    execFileSync: () => `${SHA}\trefs/heads/main\n`,
    requestJson: async (url) => {
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
    execFileSync: () => `${SHA}\trefs/heads/main\n`,
    requestJson: async (url) => {
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
    execFileSync: () => `${SHA}\trefs/heads/main\n`,
    requestJson: async (url) => {
      return { manifestVersion: '1.0', templates: [{ id: 'missing-fields' }] };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /missing string field/);
  assert.equal(fs.existsSync(path.join(dir, SHA)), false, 'malformed entries must not leave a sha cache dir');
});

test('validateCatalogShape accepts a complete template entry and rejects broken entries', () => {
  assert.equal(validateCatalogShape({ templates: [VALID_TEMPLATE] }), null);
  assert.equal(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, previewImages: [] }] }), null);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, previewImages: 'templates/spa/company/home.png' }] }), /previewImages/);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, keywords: 'portal' }] }), /keywords/);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, requiredDataverseLanguages: [] }] }), /requiredDataverseLanguages/);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, requiredDataverseLanguages: ['1033'] }] }), /requiredDataverseLanguages/);
  assert.match(validateCatalogShape({ templates: [{ ...VALID_TEMPLATE, spaCodePath: '' }] }), /spaCodePath/);
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
    spaCodePath: 'spa/311-portal/spa-code',
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

test('downloadTemplateVariant fetches the shared variant folder once and returns both artifacts', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const variantPath = 'templates/spa/company/variants/react';
  const solutionPath = `${variantPath}/solution/Company_1_0_0_0.zip`;
  const spaCodePath = `${variantPath}/spa-code`;
  const calls = [];
  let partialRoot;

  const result = downloadTemplateVariant({
    owner: 'o',
    repo: 'r',
    sha: SHA,
    solutionPath,
    spaCodePath,
    cacheRoot: dir,
  }, {
    execFileSync(command, args) {
      calls.push([command, args]);
      if (args[0] === 'init') partialRoot = args[2];
      if (args.includes('checkout')) {
        const localVariant = path.join(partialRoot, ...variantPath.split('/'));
        const localSpaCode = path.join(localVariant, 'spa-code');
        fs.mkdirSync(path.join(localSpaCode, '.powerpages-site'), { recursive: true });
        fs.writeFileSync(path.join(localSpaCode, 'powerpages.config.json'), '{}');
        fs.writeFileSync(path.join(localSpaCode, 'package.json'), '{}');
        fs.mkdirSync(path.join(localVariant, 'solution'), { recursive: true });
        fs.writeFileSync(path.join(localVariant, 'solution', 'Company_1_0_0_0.zip'), fakeZipWithLocalFile('solution.xml'));
      }
      return '';
    },
  });
  const cached = downloadTemplateVariant({
    owner: 'o',
    repo: 'r',
    sha: SHA,
    solutionPath,
    spaCodePath,
    cacheRoot: dir,
  }, {
    execFileSync() {
      throw new Error('cached variant must not run git');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.equal(result.variantPath.endsWith(path.join('templates', 'spa', 'company', 'variants', 'react')), true);
  assert.equal(result.solutionPath, path.join(result.variantPath, 'solution', 'Company_1_0_0_0.zip'));
  assert.equal(result.spaCodePath, path.join(result.variantPath, 'spa-code'));
  assert.deepEqual(cached, { ...result, cached: true });
  assert.equal(calls.filter(([, args]) => args.includes('sparse-checkout')).length, 1);
  assert.equal(calls.some(([, args]) => args.join(' ').includes(`sparse-checkout set --cone -- ${variantPath}`)), true);
});

test('templateVariantRoot requires sibling solution and spa-code folders', () => {
  assert.equal(
    templateVariantRoot(
      'templates/spa/company/variants/react/solution/Company.zip',
      'templates/spa/company/variants/react/spa-code'
    ),
    'templates/spa/company/variants/react'
  );
  assert.throws(
    () => templateVariantRoot(
      'templates/spa/company/solution/Company.zip',
      'templates/spa/company/variants/react/spa-code'
    ),
    /sibling solution\/ and spa-code\//
  );
});

test('SPA code validation rejects escaping paths and generated content', (t) => {
  assert.match(validateSpaCodePath('../outside'), /stay inside/);
  assert.match(validateSpaCodePath('/absolute/path'), /repository-relative/);
  assert.match(validateSpaCodePath('templates\\spa\\site'), /repository-relative/);
  assert.match(validateSpaCodePath('templates/spa/--upload-pack=evil/site'), /unsupported characters/);
  assert.match(validateSpaCodePath('templates/spa/site name'), /unsupported characters/);

  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.powerpages-site'));
  fs.writeFileSync(path.join(dir, 'powerpages.config.json'), '{}');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  assert.match(validateSpaCodeDirectory(dir), /generated or local-only/);
});

test('downloadSeedDataDirectory downloads a seed JSON file and its referenced __files attachments without tree API', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const downloaded = [];

  const result = await downloadSeedDataDirectory({
    owner: 'o',
    repo: 'r',
    sha: SHA,
    seedDataPath: 'templates/spa/company/seed/data.json',
    cacheRoot: dir,
  }, {
    requestJson: async () => {
      throw new Error('tree API should not be called for seed JSON paths');
    },
    downloadFile: async (_url, dest) => {
      downloaded.push(path.basename(dest));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (dest.endsWith('data.json')) {
        fs.writeFileSync(dest, JSON.stringify({
          entitySetName: 'cr123_invoices',
          records: [
            { __files: { cr123_invoicepdf: 'files/invoice.pdf' } },
            { __files: { cr123_terms: 'files/terms.docx' } },
          ],
        }));
      } else {
        fs.writeFileSync(dest, 'file-bytes');
      }
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.localDir, path.join(dir, SHA, 'templates/spa/company/seed'));
  assert.deepEqual(downloaded, ['data.json', 'invoice.pdf', 'terms.docx']);
});

test('downloadSeedDataDirectory rejects directory seed paths without calling the GitHub tree API', async () => {
  const result = await downloadSeedDataDirectory({
    owner: 'o',
    repo: 'r',
    sha: SHA,
    seedDataPath: 'templates/spa/company/seed-data',
  }, {
    requestJson: async () => {
      throw new Error('tree API should not be called');
    },
  });

  assert.deepEqual(result, {
    ok: false,
    seedDataPath: 'templates/spa/company/seed-data',
    error: 'Seed data path must point to a JSON file: templates/spa/company/seed-data',
  });
});

test('fetch-template-seed-data CLI parser accepts seed data path', () => {
  assert.deepEqual(parseSeedArgs([
    '--owner', 'contoso',
    '--repo', 'samples',
    '--sha', SHA,
    '--seedDataPath', 'templates/spa/company/seed/data.json',
    '--cacheRoot', '/tmp/cache',
  ]), {
    owner: 'contoso',
    repo: 'samples',
    sha: SHA,
    seedDataPath: 'templates/spa/company/seed/data.json',
    cacheRoot: '/tmp/cache',
  });
});

test('validateZipContainsSolution recognizes solution.xml without requiring external unzip', () => {
  assert.deepEqual(zipFileNames(fakeZipWithLocalFile('solution.xml')), ['solution.xml']);
  assert.equal(validateZipContainsSolution('/tmp/ok.zip', {
    fs: { readFileSync: () => fakeZipWithLocalFile('solution.xml') },
  }), true);
  assert.equal(validateZipContainsSolution('/tmp/nope.zip', {
    fs: { readFileSync: () => fakeZipWithLocalFile('customizations.xml') },
  }), false);
  assert.equal(validateZipContainsSolution('/tmp/nested.zip', {
    fs: { readFileSync: () => fakeZipWithLocalFile('folder/solution.xml') },
  }), false);
  assert.equal(validateZipContainsSolution('/tmp/broken.zip', {
    fs: { readFileSync: () => { throw new Error('not a zip'); } },
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

test('fetch-template-variant CLI parser accepts both sibling artifact paths', () => {
  assert.deepEqual(parseVariantArgs([
    '--owner', 'contoso',
    '--repo', 'samples',
    '--sha', SHA,
    '--solutionPath', 'templates/spa/company/variants/react/solution/Company_1_0_0_0.zip',
    '--spaCodePath', 'templates/spa/company/variants/react/spa-code',
    '--cacheRoot', '/tmp/cache',
  ]), {
    owner: 'contoso',
    repo: 'samples',
    sha: SHA,
    solutionPath: 'templates/spa/company/variants/react/solution/Company_1_0_0_0.zip',
    spaCodePath: 'templates/spa/company/variants/react/spa-code',
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

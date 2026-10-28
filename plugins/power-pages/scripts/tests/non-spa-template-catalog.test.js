const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  downloadFile,
  resolveCatalogRef,
} = require('../lib/template-catalog');
const {
  MAX_PREVIEW_BYTES,
  detectPreviewMimeType,
  loadNonSpaTemplatePresentation,
  normalizeNonSpaTemplate,
  readPreviewDataUrl,
  validateRepositoryCoordinate,
} = require('../lib/non-spa-template-catalog');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function catalogTemplate() {
  return {
    id: 'starter-layout-1',
    displayName: 'Starter Layout 1',
    description: 'Starter description',
    kind: 'non-spa',
    author: 'Microsoft',
    keywords: ['non-spa'],
    audience: ['makers'],
    provisioning: {
      type: 'create-website-api',
      templateName: 'StarterLayout1',
    },
    capabilities: ['Home page'],
    requirements: [],
    responsivePreviews: [{
      id: 'home',
      displayName: 'Home page',
      desktop: 'templates/non-spa/starter-layout-1/previews/desktop.png',
      mobile: 'templates/non-spa/starter-layout-1/previews/mobile.png',
    }],
  };
}

test('normalizes non-SPA previews to immutable raw GitHub URLs', () => {
  const result = normalizeNonSpaTemplate(catalogTemplate(), {
    owner: 'microsoft',
    repo: 'power-pages-samples',
    sha: SHA,
  });

  assert.equal(result.name, 'StarterLayout1');
  assert.equal(
    result.previews[0].desktop,
    `https://raw.githubusercontent.com/microsoft/power-pages-samples/${SHA}/templates/non-spa/starter-layout-1/previews/desktop.png`,
  );
});

test('loads one exact API template and embeds previews from the same SHA', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-spa-template-catalog-'));
  const previewPath = path.join(tempDir, 'preview.png');
  fs.writeFileSync(previewPath, PNG_BYTES);
  const downloaded = [];

  try {
    const result = await loadNonSpaTemplatePresentation({
      owner: 'microsoft',
      repo: 'power-pages-samples',
      sha: SHA,
      templateName: 'StarterLayout1',
    }, {
      fetchCatalog: async (options) => {
        assert.equal(options.ref, SHA);
        return {
          ok: true,
          owner: options.owner,
          repo: options.repo,
          sha: SHA,
          catalog: { templates: [catalogTemplate()] },
        };
      },
      downloadArtifact: async (options) => {
        downloaded.push(options);
        return { localPath: previewPath };
      },
    });

    assert.equal(result.catalog.sha, SHA);
    assert.equal(result.previews.length, 1);
    assert.match(result.previews[0].desktop, /^data:image\/png;base64,/);
    assert.deepEqual(
      downloaded.map((entry) => entry.sha),
      [SHA, SHA],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails closed on repository, revision, template, and image mismatches', async () => {
  assert.throws(
    () => validateRepositoryCoordinate('microsoft/other', '--catalogOwner'),
    /valid GitHub owner/,
  );
  await assert.rejects(
    loadNonSpaTemplatePresentation({
      owner: 'microsoft',
      repo: 'power-pages-samples',
      sha: SHA,
      templateName: 'StarterLayout1',
    }, {
      fetchCatalog: async () => ({
        ok: true,
        sha: 'abcdef0123456789abcdef0123456789abcdef01',
        catalog: { templates: [catalogTemplate()] },
      }),
    }),
    /instead of requested/,
  );
  await assert.rejects(
    loadNonSpaTemplatePresentation({
      owner: 'microsoft',
      repo: 'power-pages-samples',
      sha: SHA,
      templateName: 'UnknownTemplate',
    }, {
      fetchCatalog: async () => ({
        ok: true,
        sha: SHA,
        catalog: { templates: [catalogTemplate()] },
      }),
    }),
    /was not found/,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-SPA-template-image-'));
  try {
    const invalidPath = path.join(tempDir, 'invalid.png');
    fs.writeFileSync(invalidPath, 'not an image');
    assert.throws(
      () => readPreviewDataUrl(invalidPath, 'preview.png'),
      /not a supported/,
    );

    const oversizedPath = path.join(tempDir, 'oversized.png');
    fs.writeFileSync(oversizedPath, Buffer.alloc(MAX_PREVIEW_BYTES + 1));
    assert.throws(
      () => readPreviewDataUrl(oversizedPath, 'oversized.png'),
      /must be between/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('detects supported preview image signatures', () => {
  assert.equal(detectPreviewMimeType(PNG_BYTES), 'image/png');
  assert.equal(detectPreviewMimeType(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(
    detectPreviewMimeType(Buffer.from('RIFF0000WEBP', 'ascii')),
    'image/webp',
  );
  assert.equal(detectPreviewMimeType(Buffer.from('GIF89a', 'ascii')), null);
});

test('accepts an immutable catalog SHA without resolving a moving Git ref', () => {
  assert.deepEqual(
    resolveCatalogRef(
      { owner: 'microsoft', repo: 'power-pages-samples', ref: SHA },
      {
        execFileSync: () => {
          throw new Error('git must not run for an immutable SHA');
        },
      },
    ),
    { ref: SHA, sha: SHA },
  );
});

test('bounds preview downloads before and during streaming', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-SPA-preview-download-'));

  function httpsResponse({ contentLength, chunks }) {
    return {
      get(_url, _options, onResponse) {
        const request = new EventEmitter();
        request.destroy = (error) => request.emit('error', error);
        process.nextTick(() => {
          const response = new PassThrough();
          response.statusCode = 200;
          response.headers = contentLength === undefined
            ? {}
            : { 'content-length': String(contentLength) };
          onResponse(response);
          for (const chunk of chunks) response.write(chunk);
          response.end();
        });
        return request;
      },
    };
  }

  try {
    await assert.rejects(
      downloadFile(
        'https://raw.githubusercontent.com/example/preview.png',
        path.join(tempDir, 'declared-too-large.png'),
        {
          https: httpsResponse({ contentLength: 9, chunks: [Buffer.alloc(9)] }),
          maxBytes: 8,
          randomBytes: () => Buffer.alloc(8),
        },
      ),
      /download limit/,
    );
    await assert.rejects(
      downloadFile(
        'https://raw.githubusercontent.com/example/preview.png',
        path.join(tempDir, 'streamed-too-large.png'),
        {
          https: httpsResponse({
            chunks: [Buffer.alloc(5), Buffer.alloc(5)],
          }),
          maxBytes: 8,
          randomBytes: () => Buffer.alloc(8, 1),
        },
      ),
      /download limit/,
    );
  } finally {
    // Windows may retain the rejected download's partial-file handle until its stream closes.
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

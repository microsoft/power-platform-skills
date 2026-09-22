const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CACHE_IGNORE_ENTRY,
  inspectAssetBuffer,
  prepareDeclarativeAsset,
  safeFileName,
  validateUnsplashDownloadUrl,
  validateUnsplashRedirect,
  validateUnsplashSourcePage,
} = require('../lib/declarative-asset-preparation');

const scriptPath = path.join(__dirname, '..', 'prepare-declarative-asset.js');

function png(width = 2, height = 3) {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('stages a validated local image in the ignored customization cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-asset-'));
  const source = path.join(root, 'source image.png');
  fs.writeFileSync(source, png(640, 480));

  const result = await prepareDeclarativeAsset({
    projectRoot: root,
    sourcePath: source,
  });

  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.width, 640);
  assert.equal(result.height, 480);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(root, ...result.cachePath.split('/'))), true);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), new RegExp(CACHE_IGNORE_ENTRY));
});

test('CLI stages a local asset and rejects an invalid size limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-asset-cli-'));
  const source = path.join(root, 'source.png');
  fs.writeFileSync(source, png(80, 60));
  const accepted = spawnSync(
    process.execPath,
    [scriptPath, '--projectRoot', root, '--sourcePath', source],
    { encoding: 'utf8' }
  );
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result.status, 'ok');
  assert.equal(result.width, 80);
  assert.equal(result.height, 60);

  const rejected = spawnSync(
    process.execPath,
    [scriptPath, '--projectRoot', root, '--sourcePath', source, '--maxBytes', 'not-a-number'],
    { encoding: 'utf8' }
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /positive finite number/);
});

test('stages an approved Unsplash response and preserves source metadata outside the cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-asset-'));
  const result = await prepareDeclarativeAsset({
    projectRoot: root,
    downloadUrl: 'https://images.unsplash.com/photo-example?w=1200&fit=crop',
    sourcePage: 'https://unsplash.com/photos/example',
    fileName: 'Advisory Hero.png',
    download: async () => ({
      buffer: png(1200, 800),
      contentType: 'image/png',
      finalUrl: 'https://images.unsplash.com/photo-example?w=1200&fit=crop',
    }),
  });

  assert.equal(result.fileName, 'Advisory-Hero.png');
  assert.equal(result.finalUrl, 'https://images.unsplash.com/photo-example?w=1200&fit=crop');
  assert.equal(result.sizeBytes, 24);
});

test('rejects unsafe or mismatched asset content', () => {
  assert.throws(
    () => inspectAssetBuffer(png(), 'photo.jpg'),
    /does not match/
  );
  assert.throws(
    () =>
      inspectAssetBuffer(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>blocked()</script></svg>'),
        'pattern.svg'
      ),
    /active or embedded/
  );
  assert.throws(
    () =>
      inspectAssetBuffer(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/a.png"/></svg>'),
        'pattern.svg'
      ),
    /external resource/
  );
  assert.throws(
    () =>
      inspectAssetBuffer(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.test/a.css";</style></svg>'
        ),
        'pattern.svg'
      ),
    /active or embedded/
  );
  assert.throws(
    () =>
      inspectAssetBuffer(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:red"/></svg>'),
        'pattern.svg'
      ),
    /style attributes/
  );
  assert.throws(() => safeFileName('..\\..\\bad.exe'), /Unsupported asset extension/);
});

test('allows inert original SVG geometry and internal fragment references', () => {
  const result = inspectAssetBuffer(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20">' +
        '<defs><linearGradient id="g"/></defs><rect width="40" height="20" fill="url(#g)"/></svg>'
    ),
    'pattern.svg'
  );
  assert.deepEqual(result, { mimeType: 'image/svg+xml', width: 40, height: 20 });
});

test('restricts remote acquisition to approved Unsplash hosts', () => {
  assert.equal(
    validateUnsplashDownloadUrl('https://images.unsplash.com/photo-id?w=800').hostname,
    'images.unsplash.com'
  );
  assert.equal(
    validateUnsplashSourcePage('https://unsplash.com/photos/id').hostname,
    'unsplash.com'
  );
  for (const value of [
    'http://images.unsplash.com/photo-id',
    'https://user@example.test/photo.jpg',
    'https://images.unsplash.com.example.test/photo.jpg',
    'https://images.unsplash.com:444/photo.jpg',
  ]) {
    assert.throws(() => validateUnsplashDownloadUrl(value));
  }
  assert.throws(() => validateUnsplashSourcePage('https://community.unsplash.com/photos/id'));
  assert.equal(
    validateUnsplashRedirect(
      '/photo-next?w=800',
      new URL('https://images.unsplash.com/photo-id?w=800')
    ).hostname,
    'images.unsplash.com'
  );
  assert.throws(() =>
    validateUnsplashRedirect(
      'https://example.test/photo.jpg',
      new URL('https://images.unsplash.com/photo-id')
    )
  );
});

test('normalizes traversal-like and shell-like filenames as inert cache names', () => {
  assert.equal(safeFileName('../campaign;whoami.png'), 'campaign-whoami.png');
  assert.equal(safeFileName('C:\\brand assets\\logo $(id).svg'), 'logo-id.svg');
});

test('rejects symlink sources and oversized files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'declarative-asset-'));
  const source = path.join(root, 'source.png');
  fs.writeFileSync(source, png());
  const link = path.join(root, 'linked.png');
  try {
    fs.symlinkSync(source, link);
  } catch {
    t.skip('Symlink creation is unavailable in this environment');
    return;
  }
  await assert.rejects(
    prepareDeclarativeAsset({ projectRoot: root, sourcePath: link }),
    /regular non-symbolic file/
  );
  await assert.rejects(
    prepareDeclarativeAsset({ projectRoot: root, sourcePath: source, maxBytes: 8 }),
    /exceeds/
  );
  await assert.rejects(
    prepareDeclarativeAsset({ projectRoot: root, sourcePath: source, maxBytes: Number.NaN }),
    /positive finite number/
  );
});

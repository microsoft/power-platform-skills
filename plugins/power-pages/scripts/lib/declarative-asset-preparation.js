const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 3;
const CACHE_RELATIVE_DIR = path.join('.powerpages-customization', 'assets');
const CACHE_IGNORE_ENTRY = '/.powerpages-customization/assets/';

const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateUnsplashDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Unsplash download URL must be a valid absolute URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.toLowerCase() !== 'images.unsplash.com'
  ) {
    throw new Error(
      'Unsplash download URL must use https://images.unsplash.com without credentials or a custom port'
    );
  }
  return url;
}

function validateUnsplashSourcePage(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Unsplash source page must be a valid absolute URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['unsplash.com', 'www.unsplash.com'].includes(url.hostname.toLowerCase())
  ) {
    throw new Error(
      'Unsplash source page must use an approved unsplash.com HTTPS host without credentials or a custom port'
    );
  }
  return url;
}

function validateUnsplashRedirect(location, baseUrl) {
  if (!location) throw new Error('Unsplash redirect is missing a Location header');
  return validateUnsplashDownloadUrl(new URL(location, baseUrl).toString());
}

function requestBuffer(url, options = {}) {
  const {
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    redirectsRemaining = MAX_REDIRECTS,
    request = https.request,
  } = options;

  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (error, value) => {
      if (completed) return;
      completed = true;
      if (error) reject(error);
      else resolve(value);
    };
    const req = request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'image/webp,image/png,image/jpeg,*/*;q=0.1',
          'User-Agent': 'power-platform-skills-declarative-asset-preparation',
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (redirectsRemaining <= 0) {
            finish(new Error('Unsplash download exceeded the redirect limit'));
            return;
          }
          let redirect;
          try {
            redirect = validateUnsplashRedirect(response.headers.location, url);
          } catch (error) {
            finish(error);
            return;
          }
          requestBuffer(redirect, {
            ...options,
            maxBytes,
            timeoutMs,
            redirectsRemaining: redirectsRemaining - 1,
            request,
          }).then((value) => finish(null, value), finish);
          return;
        }
        if (status !== 200) {
          response.resume();
          finish(new Error(`Unsplash download returned HTTP ${status}`));
          return;
        }
        const contentLength = Number(response.headers['content-length'] || 0);
        if (contentLength > maxBytes) {
          response.resume();
          finish(new Error(`Asset exceeds the ${maxBytes}-byte download limit`));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy(new Error(`Asset exceeds the ${maxBytes}-byte download limit`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          finish(null, {
            buffer: Buffer.concat(chunks),
            contentType: String(response.headers['content-type'] || '')
              .split(';')[0]
              .trim()
              .toLowerCase(),
            finalUrl: url.toString(),
          })
        );
        response.on('error', finish);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Asset download timed out')));
    req.on('error', finish);
    req.end();
  });
}

function inspectSvg(buffer) {
  const text = buffer.toString('utf8');
  if (!/<svg(?:\s|>)/i.test(text)) throw new Error('SVG source does not contain an svg root');
  // SVG is active XML content. Reject executable/embed boundaries and any external resource
  // reference; simple geometry, gradients, masks, symbols, and internal fragment references remain.
  if (/<!doctype|<!entity|<\?xml-stylesheet/i.test(text)) {
    throw new Error('SVG declarations, entities, and external stylesheets are not allowed');
  }
  if (/<\s*(script|style|foreignObject|iframe|object|embed|audio|video)\b/i.test(text)) {
    throw new Error('SVG contains active or embedded content');
  }
  if (/\son[a-z0-9_-]+\s*=/i.test(text)) throw new Error('SVG event handlers are not allowed');
  if (/\sstyle\s*=/i.test(text)) throw new Error('SVG style attributes are not allowed');
  const references = [
    ...text.matchAll(/\b(?:href|xlink:href)\s*=\s*(['"])(.*?)\1/gi),
    ...text.matchAll(/\burl\(\s*(['"]?)(.*?)\1\s*\)/gi),
  ];
  for (const match of references) {
    const target = match[2].trim();
    if (target && !target.startsWith('#')) {
      throw new Error('SVG external resource references are not allowed');
    }
  }
  const root = text.match(/<svg\b([^>]*)>/i);
  const attributes = root ? root[1] : '';
  const viewBox = attributes.match(
    /\bviewBox\s*=\s*(['"])\s*[-+\d.eE]+\s+[-+\d.eE]+\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*\1/i
  );
  const width = attributes.match(/\bwidth\s*=\s*(['"])\s*([\d.]+)(?:px)?\s*\1/i);
  const height = attributes.match(/\bheight\s*=\s*(['"])\s*([\d.]+)(?:px)?\s*\1/i);
  return {
    width: viewBox ? Math.round(Number(viewBox[2])) : width ? Math.round(Number(width[2])) : null,
    height: viewBox
      ? Math.round(Number(viewBox[3]))
      : height
        ? Math.round(Number(height[2]))
        : null,
  };
}

function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG dimensions could not be read');
}

function readWebpDimensions(buffer) {
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  throw new Error('WebP dimensions could not be read');
}

function inspectAssetBuffer(buffer, fileName, suppliedContentType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Asset file is empty');
  const extension = path.extname(fileName).toLowerCase();
  const expectedMime = MIME_BY_EXTENSION.get(extension);
  if (!expectedMime) throw new Error(`Unsupported asset extension ${extension || '(none)'}`);

  let detectedMime;
  let dimensions = { width: null, height: null };
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    detectedMime = 'image/png';
    if (buffer.length < 24) throw new Error('PNG is truncated');
    dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    detectedMime = 'image/jpeg';
    dimensions = readJpegDimensions(buffer);
  } else if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    detectedMime = 'image/webp';
    dimensions = readWebpDimensions(buffer);
  } else if (/^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(buffer.toString('utf8', 0, 512))) {
    detectedMime = 'image/svg+xml';
    dimensions = inspectSvg(buffer);
  } else if (buffer.toString('ascii', 0, 4) === 'wOFF') {
    detectedMime = 'font/woff';
  } else if (buffer.toString('ascii', 0, 4) === 'wOF2') {
    detectedMime = 'font/woff2';
  } else {
    throw new Error('Asset signature is not a supported image, SVG, or font');
  }

  if (detectedMime !== expectedMime) {
    throw new Error(`Asset signature ${detectedMime} does not match ${extension}`);
  }
  if (suppliedContentType && suppliedContentType !== detectedMime) {
    throw new Error(
      `Remote Content-Type ${suppliedContentType} does not match detected type ${detectedMime}`
    );
  }
  if (
    detectedMime.startsWith('image/') &&
    detectedMime !== 'image/svg+xml' &&
    (!dimensions.width || !dimensions.height)
  ) {
    throw new Error('Raster image dimensions must be positive');
  }
  return { mimeType: detectedMime, ...dimensions };
}

function safeFileName(value) {
  const base = path.basename(String(value || '')).normalize('NFKC');
  if (!base || base === '.' || /[\u0000-\u001f\u007f]/.test(base)) {
    throw new Error('Asset filename is invalid');
  }
  const extension = path.extname(base).toLowerCase();
  if (!MIME_BY_EXTENSION.has(extension)) {
    throw new Error(`Unsupported asset extension ${extension || '(none)'}`);
  }
  const stem = path.basename(base, path.extname(base))
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!stem) throw new Error('Asset filename has no safe basename');
  return `${stem}${extension}`;
}

function ensureCacheIgnored(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  if (lines.includes(CACHE_IGNORE_ENTRY)) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignorePath, `${prefix}${CACHE_IGNORE_ENTRY}\n`, 'utf8');
}

async function prepareDeclarativeAsset(options) {
  const {
    projectRoot,
    sourcePath,
    downloadUrl,
    sourcePage,
    fileName,
    expectedSha256,
    maxBytes = DEFAULT_MAX_BYTES,
    download = requestBuffer,
  } = options;
  if (!projectRoot) throw new Error('projectRoot is required');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('maxBytes must be a positive finite number');
  }
  if ((sourcePath ? 1 : 0) + (downloadUrl ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of sourcePath or downloadUrl');
  }
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${root}`);
  }

  let buffer;
  let contentType = '';
  let finalUrl = null;
  let resolvedFileName;
  if (sourcePath) {
    const source = path.resolve(sourcePath);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Local asset source must be a regular non-symbolic file');
    }
    if (stat.size > maxBytes) throw new Error(`Asset exceeds the ${maxBytes}-byte limit`);
    buffer = fs.readFileSync(source);
    resolvedFileName = safeFileName(fileName || path.basename(source));
  } else {
    const remote = validateUnsplashDownloadUrl(downloadUrl);
    validateUnsplashSourcePage(sourcePage);
    resolvedFileName = safeFileName(fileName);
    const response = await download(remote, { maxBytes });
    buffer = response.buffer;
    contentType = response.contentType;
    finalUrl = response.finalUrl;
  }

  const inspected = inspectAssetBuffer(buffer, resolvedFileName, contentType);
  const hash = sha256(buffer);
  if (expectedSha256 && hash !== expectedSha256.toLowerCase()) {
    throw new Error('Prepared asset SHA-256 does not match the approved value');
  }

  const cacheRoot = path.join(root, CACHE_RELATIVE_DIR);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(cacheRoot, `${hash}-${resolvedFileName}`);
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile() || sha256(fs.readFileSync(destination)) !== hash) {
      throw new Error(`Asset cache collision at ${destination}`);
    }
  } else {
    fs.writeFileSync(destination, buffer, { flag: 'wx', mode: 0o600 });
  }
  ensureCacheIgnored(root);

  return {
    cachePath: path.relative(root, destination).split(path.sep).join('/'),
    fileName: resolvedFileName,
    mimeType: inspected.mimeType,
    width: inspected.width,
    height: inspected.height,
    sizeBytes: buffer.length,
    sha256: hash,
    finalUrl,
  };
}

module.exports = {
  CACHE_IGNORE_ENTRY,
  CACHE_RELATIVE_DIR,
  DEFAULT_MAX_BYTES,
  inspectAssetBuffer,
  inspectSvg,
  prepareDeclarativeAsset,
  requestBuffer,
  safeFileName,
  sha256,
  validateUnsplashDownloadUrl,
  validateUnsplashRedirect,
  validateUnsplashSourcePage,
};

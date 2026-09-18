'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const { atomicWrite, digest, exists, inside, plainDirectory, readFile, readJson } = require('./mobile-authoring-files');
const { assertRevision, revision } = require('./prototype-files');
const { publicHttps, referencedMediaKeys, validateImageAsset, validateScenarioImages } = require('./prototype-images');

const MANIFEST = '.tmp/prototype-image-assets.json';
const FACTS = '.tmp/scenario-facts.json';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 50 * 1000 * 1000;
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && /^[23][a-f0-9]{3}:/i.test(address) && !blocked.check(address, 'ipv6');
}

async function downloadImage(value, { lookup = dns.lookup, request = https.get, timeoutMs = 15000 } = {}) {
  publicHttps(value, 'Sample image download', { image: true });
  const controller = new AbortController();
  let activeRequest;
  let timedOut = false;
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      activeRequest?.destroy();
      reject(new Error('Sample image download timed out'));
    }, timeoutMs);
  });
  const run = async () => {
    let current = value;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      publicHttps(current, 'Sample image download', { image: true });
      const url = new URL(current);
      const addresses = await lookup(url.hostname, { all: true, verbatim: true });
      if (timedOut) throw new Error('Sample image download timed out');
      if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
        throw new Error('Sample image DNS must resolve only to public addresses');
      }
      const result = await new Promise((resolve, reject) => {
        const selected = addresses[0];
        activeRequest = request(url, {
          agent: false,
          signal: controller.signal,
          headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'PowerApps-Mobile-Sample-Images/1.0' },
          lookup: (hostname, options, callback) => {
            if (hostname !== url.hostname) return callback(new Error('Unexpected sample image hostname'));
            if (options?.all) callback(null, addresses);
            else callback(null, selected.address, selected.family);
          },
        }, response => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) reject(new Error('Sample image redirect has no location'));
            else resolve({ location });
            return;
          }
          const mimeType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (response.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)
            || Number(response.headers['content-length']) > MAX_IMAGE_BYTES) {
            response.destroy();
            reject(new Error('Sample image response must be a bounded JPEG, PNG or WebP with HTTP 200'));
            return;
          }
          const chunks = [];
          let length = 0;
          response.on('data', chunk => {
            length += chunk.length;
            if (length > MAX_IMAGE_BYTES) {
              response.destroy();
              reject(new Error('Sample image exceeds the download byte limit'));
            } else chunks.push(chunk);
          });
          response.on('end', () => resolve({ bytes: Buffer.concat(chunks), mimeType }));
          response.on('error', () => reject(new Error('Sample image response failed')));
          response.on('aborted', () => reject(new Error('Sample image response was interrupted')));
        });
        activeRequest.on('error', () => reject(new Error('Sample image download failed')));
      });
      if (!result.location) return result;
      current = new URL(result.location, url).href;
    }
    throw new Error('Sample image redirect limit exceeded');
  };
  try { return await Promise.race([run(), timeout]); }
  finally { clearTimeout(timer); }
}

function inspectImage(bytes, mimeType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Sample image must contain at most 5 MiB of image bytes');
  }
  let width, height, extension, detected;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') {
    detected = 'image/png'; extension = 'png';
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 12 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
    detected = 'image/jpeg'; extension = 'jpg';
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    detected = 'image/webp'; extension = 'webp';
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const size = bytes.readUInt32LE(21);
      width = (size & 0x3fff) + 1; height = ((size >>> 14) & 0x3fff) + 1;
    } else if (kind === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
  }
  if (!detected || detected !== mimeType) throw new Error('Sample image bytes do not match a supported image Content-Type');
  if (!width || !height || width > 12000 || height > 12000 || width * height > MAX_PIXELS) {
    throw new Error('Sample image dimensions must be bounded to 12000 per side and 50 million pixels');
  }
  return { mimeType: detected, extension, width, height };
}

function canonicalImages(facts) {
  if (facts.contractType !== 'scenario-facts') throw new Error('Sample images require canonical scenario facts');
  assertRevision(facts, 'scenarioRevision', 'Scenario facts');
  const errors = validateScenarioImages(facts.records, facts.mediaAssets);
  if (errors.length) throw new Error(errors[0].message);
  const referenced = new Set(facts.records.flatMap(referencedMediaKeys));
  return facts.mediaAssets.filter(asset => referenced.has(asset.key)).map(validateImageAsset)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function readManifest(root) {
  if (!exists(root, MANIFEST)) return [];
  const manifest = readJson(root, MANIFEST);
  assertRevision(manifest, 'assetsRevision', 'Bundled sample images');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 200
    || new Set(manifest.assets.map(entry => entry.key)).size !== manifest.assets.length) {
    throw new Error('Bundled sample image manifest is invalid');
  }
  let total = 0;
  for (const entry of manifest.assets) {
    if (!/^[a-f0-9]{64}$/.test(entry.assetRevision) || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !['png', 'jpg', 'webp'].some(extension => entry.path === `assets/sample-media/${entry.assetRevision}.${extension}`)) {
      throw new Error('Bundled sample image path or integrity metadata is invalid');
    }
    const bytes = readFile(inside(root, entry.path), MAX_IMAGE_BYTES);
    if (bytes.length !== entry.byteLength || digest(bytes) !== entry.sha256) throw new Error('Bundled sample image bytes changed or are corrupt');
    const image = inspectImage(bytes, entry.mimeType);
    if (image.width !== entry.width || image.height !== entry.height || !entry.path.endsWith(`.${image.extension}`)) {
      throw new Error('Bundled sample image dimensions changed or are corrupt');
    }
    total += bytes.length;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error('Bundled sample images exceed the 20 MiB aggregate limit');
  return manifest.assets;
}

function readBundledImages(root, facts, { required = false } = {}) {
  const images = canonicalImages(facts);
  if (!exists(root, MANIFEST) && !required) return [];
  const entries = readManifest(root);
  return images.map(asset => {
    const entry = entries.find(image => image.key === asset.key && image.assetRevision === revision(asset));
    if (!entry) throw new Error('Bundled sample images are missing or stale; run materialize-prototype-images');
    return entry;
  });
}

async function materializePrototypeImages(projectRoot, { check = false, download = downloadImage, verify = async () => {} } = {}) {
  const root = plainDirectory(projectRoot);
  await verify();
  const facts = readJson(root, FACTS);
  const assets = canonicalImages(facts);
  if (check) {
    const images = readBundledImages(root, facts, { required: true });
    return { ok: true, bundledCount: images.length, downloadedCount: 0, byteLength: images.reduce((total, entry) => total + entry.byteLength, 0) };
  }
  const existing = readManifest(root);
  const pending = [];
  const images = [];
  let total = 0;
  for (const asset of assets) {
    const assetRevision = revision(asset);
    const cached = existing.find(entry => entry.key === asset.key && entry.assetRevision === assetRevision);
    if (cached) { images.push(cached); total += cached.byteLength; continue; }
    await verify();
    const response = await download(asset.source.value);
    const image = inspectImage(response.bytes, response.mimeType);
    total += response.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Bundled sample images exceed the 20 MiB aggregate limit');
    const entry = {
      key: asset.key, assetRevision, path: `assets/sample-media/${assetRevision}.${image.extension}`,
      sha256: digest(response.bytes), byteLength: response.bytes.length,
      mimeType: image.mimeType, width: image.width, height: image.height,
    };
    if (exists(root, entry.path) && digest(readFile(inside(root, entry.path), MAX_IMAGE_BYTES)) !== entry.sha256) {
      throw new Error('Bundled sample image destination changed outside its materializer');
    }
    pending.push({ entry, bytes: response.bytes });
    images.push(entry);
  }
  await verify();
  if (total > MAX_TOTAL_BYTES) throw new Error('Bundled sample images exceed the 20 MiB aggregate limit');
  if (revision(readJson(root, FACTS)) !== revision(facts)) throw new Error('Canonical sample images changed during download');
  for (const { entry, bytes } of pending) {
    if (!exists(root, entry.path)) atomicWrite(root, entry.path, bytes, { bytes: true, exclusive: true });
  }
  const manifest = { schemaVersion: 1, assets: images };
  atomicWrite(root, MANIFEST, { ...manifest, assetsRevision: revision(manifest) });
  readBundledImages(root, facts, { required: true });
  return { ok: true, bundledCount: images.length, downloadedCount: pending.length, byteLength: total };
}

module.exports = { MANIFEST, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, downloadImage, inspectImage, readBundledImages, materializePrototypeImages };